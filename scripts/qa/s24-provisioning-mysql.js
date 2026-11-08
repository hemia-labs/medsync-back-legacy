'use strict';
// No configured database or env loader is used for SQL. Local synthetic server only.
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const mysql=require('mysql2/promise');
const {Sequelize,QueryTypes}=require('sequelize');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {RegistrationService}=require('../../src/services/registration/registration.service');
const {SaasLegalDao}=require('../../src/Dao/mysql/saasLegal.dao');
const {findOwner}=require('../../src/services/registration/identityAuth');
const passwordService=require('../../src/services/security/registrationPassword.service');
const {compare}=require('../../src/util/bcrypt');
const identitySchema=require('../migrations/s24IdentitySchema');
const root=path.resolve(__dirname,'../../..');

async function run({quiet=false}={}) {
    if(process.env.S24_QA_ISOLATED!=='1') throw Error('S24_QA_ISOLATED=1 required');
    const port=Number(process.env.S24_QA_PORT || 33324);
    if(!Number.isInteger(port) || port===3306) throw Error('Dedicated QA port required');
    const database='s24b_qa_'+randomUUID().replaceAll('-','');
    const bootstrap=await mysql.createConnection({host:'127.0.0.1',port,user:'root',password:''});
    const tables=['business','rol','login','appointment_config','cat_ui_theme','ui_theme_configuration','admin_audit_log',
        'cat_permission','permission_rol','business_role_permission','doctor_professional_profile','session','refresh_token','auth_password_reset_tokens'];
    try {
        await bootstrap.query('CREATE DATABASE '+mysql.escapeId(database)+' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await bootstrap.changeUser({database});
        for(const table of tables) {
            const file=await fs.readFile(path.join(root,'u575589445_orrico/Tables',table+'.sql'),'utf8');
            const ddl=file.match(/CREATE TABLE[\s\S]*?;\s*$/)[0];
            assert.ok(!/DROP\s+TABLE/i.test(ddl));await bootstrap.query(ddl);
        }
        const legalSchema=await fs.readFile(path.join(root,'hemia-assistance-back-legacy/scripts/migrations/saas-legal-documents.sql'),'utf8');
        for(const sql of legalSchema.split(/;\s*(?:\r?\n|$)/).map(s=>s.trim()).filter(Boolean)) await bootstrap.query(sql);
        await bootstrap.query("INSERT INTO rol(id_rol,code,desc_rol,active) VALUES ('admin','admin','Admin',1),('publisher','super_admin','Publisher',1),('reception','reception','Reception',1)");
        await bootstrap.query("INSERT INTO login(id_login,id_rol,name,telephone,email,active) VALUES ('publisher','publisher','Synthetic publisher','5550000000','publisher@example.test',1)");
        const codes=['px.dates','px.tab.monitoring','clinical_history.edit_draft','dashboard.operations','dashboard.clinical','dashboard.scope.all','dashboard.financial','tracing.create','tracing.correct','tracing.cancel'];
        for(const code of codes) await bootstrap.query('INSERT INTO cat_permission(id_cat_permission,code,name,description) VALUES (?,?,?,?)',[code,code,code,'Synthetic']);
        for(const code of ['px.dates','px.tab.monitoring','clinical_history.edit_draft']) await bootstrap.query('INSERT INTO permission_rol(id_permission_rol,id_rol,id_cat_permission) VALUES (?,\'admin\',?)',[randomUUID(),code]);
        const [themeColumns]=await bootstrap.query('SHOW COLUMNS FROM cat_ui_theme');
        const columns=themeColumns.filter(c=>c.Null==='NO').map(c=>c.Field);
        await bootstrap.query('INSERT INTO cat_ui_theme ('+columns.map(mysql.escapeId).join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')',
            columns.map(c=>c==='code'?'medical-blue':c==='id_cat_ui_theme'?'theme':c==='name'?'Synthetic':'#123456'));
        for(const sql of identitySchema.statements) await bootstrap.query(sql);
        await bootstrap.beginTransaction();await identitySchema.backfill(bootstrap);await bootstrap.commit();
        await require('../migrations/s25-registration-email-login').apply(bootstrap,path.join(root,'_schema_backups',database+'-s25'));
        const {preflight}=require('../migrations/s24-registration-provisioning');
        assert.equal((await preflight(bootstrap)).ready,true);
        await bootstrap.query(await fs.readFile(path.join(root,'hemia-assistance-back-legacy/scripts/migrations/s24-registration-provisioning.sql'),'utf8'));
        assert.equal((await preflight(bootstrap)).alreadyPresent,true);
        const loginProcedure=await fs.readFile(path.join(root,'u575589445_orrico/Procedures/SP_login_by_idlogin.sql'),'utf8');
        await bootstrap.query(loginProcedure.slice(loginProcedure.indexOf('CREATE '),loginProcedure.lastIndexOf('//')).replace(/CREATE DEFINER=.*? PROCEDURE/,'CREATE PROCEDURE').trim());
    } finally {await bootstrap.end();}

    const connect=()=>new Sequelize(database,'root','',{host:'127.0.0.1',port,dialect:'mysql',logging:false,pool:{max:1,min:0,idle:1000}});
    const db=connect(),other=connect();
    let lastFailure;
    const rawQuery=db.query.bind(db);
    db.query=async(sql,...args)=>{try{return await rawQuery(sql,...args);}catch(error){
        lastFailure={code:error.original && error.original.code,operation:String(sql).trim().slice(0,65).replace(/:[A-Za-z_]+/g,'?')};throw error;
    }};
    const options={key:()=>Buffer.alloc(32,7),identityEnabled:()=>true,loadBlocklist:async()=>new Set(['a common password for tests'])};
    const service=new RegistrationService(db,options),secondService=new RegistrationService(other,options),legal=new SaasLegalDao(db);
    const checks=[];const pass=name=>checks.push(name);
    const q=(sql,replacements={})=>db.query(sql,{replacements,type:QueryTypes.SELECT});
    const context={id_login:'publisher',rol:'super_admin'};
    const publicVersions={};
    const attempt=()=>({id:randomUUID(),secret:randomBytes(32).toString('hex')});
    let seq=1;
    const input=()=>({account:{name:'  Administradora de prueba  ',telephone:'555'+String(seq++).padStart(7,'0'),email:'qa'+seq+'@example.test',password:' Una clave extensa y privada '+seq+' '},
        business:{name:'Consultorio compartido'},legalAcceptances:['terms_conditions','privacy_notice'].map(key=>({documentKey:key,versionId:publicVersions[key],acknowledged:true}))});
    const tracked=[...tables.filter(t=>!['rol','cat_permission','permission_rol','cat_ui_theme'].includes(t)),
        'auth_identity','registration_attempt','registration_outbox','saas_legal_acceptances'];
    const counts=async()=>{const n={};for(const table of tracked)n[table]=Number((await q('SELECT COUNT(*) n FROM '+table))[0].n);return n;};
    try {
        for(const key of ['terms_conditions','privacy_notice']) {
            assert.equal((await legal.saveDraft(context,key,{title:key,description:'Synthetic only',content_html:'<p>Documento de prueba, sin efecto contractual real.</p>',required:true,expected_revision:1})).status,200);
            const published=await legal.publish(context,key,{expected_revision:2});assert.equal(published.status,200);
            publicVersions[key]=published.data.document.current_version.id_version;
        }
        const first=input(),firstAttempt=attempt();
        const result=await service.create(first,firstAttempt);assert.equal(result.status,201,JSON.stringify({result,lastFailure}));
        const business=(await q('SELECT * FROM business WHERE id_business=:id',{id:result.data.idBusiness}))[0];
        assert.equal(business.subscription_status,'pending_activation');assert.equal(business.plan,null);assert.equal(business.trial_ends_at,null);
        assert.equal(business.phone,null,'Account contact is not published to the clinic');
        const account=(await q('SELECT * FROM login WHERE id_login=:id',{id:result.data.idLogin}))[0];
        assert.equal(account.id_rol,'admin');assert.equal(account.created_by,account.id_login);assert.equal(account.name,first.account.name.trim());
        assert.ok(await compare(first.account.password,account.password));assert.equal(await compare(first.account.password.trim(),account.password),false);
        const docs=(await legal.current({id_login:account.id_login,id_business:business.id_business,rol:'admin'})).data.documents;
        assert.equal(docs.filter(d=>d.accepted).length,2);
        assert.equal((await q('SELECT COUNT(*) n FROM doctor_professional_profile'))[0].n,0);
        assert.equal((await q('SELECT COUNT(*) n FROM appointment_config WHERE id_business=:id',{id:business.id_business}))[0].n,1);
        assert.equal((await q('SELECT COUNT(*) n FROM ui_theme_configuration WHERE id_business=:id',{id:business.id_business}))[0].n,1);
        const grants=await q('SELECT id_cat_permission,active FROM business_role_permission WHERE id_business=:id AND id_rol=\'admin\'',{id:business.id_business});
        assert.ok(grants.some(g=>g.id_cat_permission==='dashboard.operations'&&g.active===1));
        assert.ok(!grants.some(g=>['dashboard.financial','dashboard.clinical','tracing.correct','tracing.cancel'].includes(g.id_cat_permission)&&g.active===1));
        const records=JSON.stringify(await q('SELECT metadata_json FROM admin_audit_log'))+JSON.stringify(await q('SELECT * FROM registration_outbox'))+JSON.stringify(await q('SELECT * FROM registration_attempt'));
        for(const sensitive of [first.account.password,first.account.email,first.account.telephone,firstAttempt.secret])assert.ok(!records.includes(sensitive));
        pass('atomic creation: pending business, admin, defaults, existing grants, 2 legal versions, audit and outbox; no clinical profile or plaintext secrets');

        const baseline=await counts();
        const replay=await service.create(first,firstAttempt);assert.equal(replay.status,200);assert.equal(replay.data.idLogin,account.id_login);assert.equal(replay.data.replayed,true);
        assert.deepEqual(await counts(),baseline);
        assert.equal((await service.create({...first,business:{name:'Changed'}},firstAttempt)).code,'REGISTRATION_ATTEMPT_CONFLICT');
        assert.equal((await service.create(first,{...firstAttempt,secret:randomBytes(32).toString('hex')})).code,'REGISTRATION_ATTEMPT_CONFLICT');
        assert.equal((await service.create(first,attempt())).status,409);assert.deepEqual(await counts(),baseline);
        pass('replay receipt without session, changed scope/payload rejection and duplicate identity rollback');

        const invalids=[{...input(),role:'super_admin'}, {...input(),business:{name:'X',plan:'pro'}},
            {...input(),legalAcceptances:[{documentKey:'terms_conditions',versionId:publicVersions.terms_conditions,acknowledged:true},{documentKey:'terms_conditions',versionId:publicVersions.terms_conditions,acknowledged:true}]}];
        const unaccepted=input();unaccepted.legalAcceptances[0].acknowledged=false;invalids.push(unaccepted);
        for(const payload of invalids)assert.equal((await service.create(payload,attempt())).status,400);
        const stale=input();stale.legalAcceptances[0].versionId='unknown';assert.equal((await service.create(stale,attempt())).code,'LEGAL_VERSION_STALE');
        await db.query("UPDATE saas_legal_documents SET current_version_id=NULL WHERE document_key='privacy_notice'");
        assert.equal((await service.create(input(),attempt())).code,'LEGAL_UNAVAILABLE');
        await db.query("UPDATE saas_legal_documents SET current_version_id=:id WHERE document_key='privacy_notice'",{replacements:{id:publicVersions.privacy_notice}});
        assert.deepEqual(await counts(),baseline);
        pass('whitelist, explicit independent consent, stale/missing publication all reject without persistent partial data');

        const legalLock=await db.transaction();
        await db.query("SELECT id_document FROM saas_legal_documents WHERE document_key='privacy_notice' FOR UPDATE",{transaction:legalLock});
        let reachedHead;
        const headQuery=new Promise(resolve=>{reachedHead=resolve;});
        const publishingRaceDb={transaction:()=>other.transaction(),query:(sql,opts)=>{
            if(sql.includes('FROM saas_legal_documents')&&opts.replacements.key==='privacy_notice')reachedHead();
            return other.query(sql,opts);
        }};
        const waitingRegistration=new RegistrationService(publishingRaceDb,options).create(input(),attempt());
        // Signal before the locking SELECT reaches MySQL; the preexisting lock
        // guarantees registration cannot consume the earlier published pointer.
        await headQuery;
        await db.query("UPDATE saas_legal_documents SET current_version_id=NULL WHERE document_key='privacy_notice'",{transaction:legalLock});
        await legalLock.commit();
        assert.equal((await waitingRegistration).code,'LEGAL_UNAVAILABLE');
        await db.query("UPDATE saas_legal_documents SET current_version_id=:id WHERE document_key='privacy_notice'",{replacements:{id:publicVersions.privacy_notice}});
        assert.deepEqual(await counts(),baseline);
        pass('concurrent legal-head change is revalidated under lock; no acceptance of a withdrawn version');

        for(const point of ['INSERT INTO appointment_config','INSERT INTO login','INSERT INTO saas_legal_acceptances','INSERT INTO admin_audit_log','INSERT INTO registration_outbox']) {
            let hits=0;
            const injected={transaction:()=>db.transaction(),query:(sql,opts)=>{
                if(sql.includes(point) && (++hits >= (point==='INSERT INTO saas_legal_acceptances'?2:1))) throw Error('Synthetic failure');
                return db.query(sql,opts);
            }};
            assert.equal((await new RegistrationService(injected,options).create(input(),attempt())).status,503);
            assert.deepEqual(await counts(),baseline,'rollback at '+point);
        }
        pass('failure at agenda, admin, second acceptance, strict audit or outbox rolls back every creation');

        const concurrent=input(),sharedAttempt=attempt();
        const together=await Promise.all([service.create(concurrent,sharedAttempt),secondService.create(concurrent,sharedAttempt)]);
        assert.deepEqual(together.map(x=>x.status).sort(),[200,201]);assert.equal(together[0].data.idLogin,together[1].data.idLogin);
        const competing=input();
        const race=await Promise.all([service.create(competing,attempt()),secondService.create(competing,attempt())]);
        assert.deepEqual(race.map(x=>x.status).sort(),[201,409]);
        const repeatName=await service.create(input(),attempt());assert.equal(repeatName.status,201);
        pass('real concurrent retries: same attempt one account; separate attempts same identity one winner; repeated business name allowed');

        const committed=input(),committedAttempt=attempt();
        const lostReply={query:(sql,opts)=>db.query(sql,opts),transaction:async()=>{
            const tx=await db.transaction(),commit=tx.commit.bind(tx);
            tx.commit=async()=>{await commit();throw Error('Synthetic disconnect after commit');};return tx;
        }};
        assert.equal((await new RegistrationService(lostReply,options).create(committed,committedAttempt)).status,503);
        const beforeRetry=await counts();assert.equal((await service.create(committed,committedAttempt)).status,200);assert.deepEqual(await counts(),beforeRetry);
        pass('unknown commit outcome recovered with same attempt and no duplicate account');

        assert.equal((await findOwner(db,first.account.telephone)).id_login,account.id_login);
        assert.equal(await findOwner(db,first.account.telephone,{recovery:true}),null,'Unverified email cannot reset a new credential');
        await db.query("UPDATE auth_identity SET reservation_status='verified',expires_at=NULL,verified_at=NOW(3) WHERE kind='email' AND id_login=:id",{replacements:{id:account.id_login}});
        assert.equal((await findOwner(db,first.account.telephone,{recovery:true})).id_login,account.id_login);
        await db.query("UPDATE auth_identity SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE kind='phone' AND id_login=:id",{replacements:{id:account.id_login}});
        const reclaim=input();reclaim.account.telephone=first.account.telephone;
        const claimed=await service.create(reclaim,attempt());assert.equal(claimed.status,201);
        assert.equal((await findOwner(db,first.account.telephone)).id_login,claimed.data.idLogin);
        pass('login lookup follows current identity owner after expiry; recovery requires separately verified email');

        await db.query('UPDATE registration_attempt SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE attempt_id=:id',{replacements:{id:committedAttempt.id}});
        assert.equal((await service.create(committed,committedAttempt)).code,'REGISTRATION_ATTEMPT_EXPIRED');
        const blocked=input();blocked.account.password='a common password for tests';assert.equal((await service.create(blocked,attempt())).code,'PASSWORD_COMPROMISED');
        assert.equal((await new RegistrationService(db,{...options,key:()=>null}).create(input(),attempt())).status,503);
        pass('expired attempt, local password blocklist and missing signing configuration fail closed');

        // Execute the actual existing login/reset DAO with this isolated SQL
        // connection, synthetic signing secrets and a mail double (no delivery).
        const sharedDb=require('../../src/db/Sequelize.connection');
        const oldDb={query:sharedDb.query,transaction:sharedDb.transaction};
        const security=require('../../src/config/security'),oldSecret=security.getPasswordResetCodeSecret;
        const jwtConfig=require('../../src/config/jwt'),oldJwt=jwtConfig.key;
        const mail=require('../../src/mail/mail'),oldMail=mail.SendPasswordChanged;
        const savedEnv={};
        for(const key of ['REGISTRATION_IDENTITY_ENABLED','REGISTRATION_PASSWORD_BLOCKLIST_PATH','REGISTRATION_PASSWORD_BLOCKLIST_SHA256']) savedEnv[key]=process.env[key];
        try {
            sharedDb.query=(sql,opts)=>db.query(sql,opts);sharedDb.transaction=(...args)=>db.transaction(...args);
            security.getPasswordResetCodeSecret=()=> 's24-synthetic-recovery-only';jwtConfig.key='s24-synthetic-jwt-only';
            mail.SendPasswordChanged=async()=>({process:true});
            process.env.REGISTRATION_IDENTITY_ENABLED='true';
            const policyPath=path.join(root,'_qa/s24-r2',database+'-synthetic-blocklist.json');
            const policy=JSON.stringify({version:'qa-v1',source:'Synthetic fixtures, not a release list',license:'Test-only original data',passwords:['a common password for tests']});
            await fs.writeFile(policyPath,policy);
            process.env.REGISTRATION_PASSWORD_BLOCKLIST_PATH=policyPath;
            process.env.REGISTRATION_PASSWORD_BLOCKLIST_SHA256=createHash('sha256').update(policy).digest('hex');
            const auth=require('../../src/Dao/mysql/auth.dao');
            const loggedIn=await auth.login({param:committed.account.telephone,pwd:committed.account.password,refresh:false});
            assert.equal(loggedIn.status,200);assert.ok(loggedIn.data.token);assert.equal(loggedIn.data.tenantOperational.allowed,false);
            assert.equal((await auth.login({param:committed.account.telephone,pwd:'wrong password value',refresh:false})).status,404);
            const owner=await findOwner(db,committed.account.telephone);
            await db.query("UPDATE auth_identity SET reservation_status='verified',expires_at=NULL,verified_at=NOW(3) WHERE kind='email' AND id_login=:id",{replacements:{id:owner.id_login}});
            const resetTokens=require('../../src/services/security/passwordResetToken.service');
            const code='123456', codeHash=resetTokens.hashCode(committed.account.email,code);
            await db.query(`INSERT INTO auth_password_reset_tokens(id_login,identifier_normalized,destination_email_fingerprint,code_hash,code_fingerprint,status,issued_at,expires_at,created_at)
                VALUES (:id,:phone,:email,:hash,:fingerprint,'verified',NOW(),DATE_ADD(NOW(),INTERVAL 10 MINUTE),NOW())`,
            {replacements:{id:owner.id_login,phone:committed.account.email,email:resetTokens.fingerprintEmail(owner.email),hash:codeHash,fingerprint:resetTokens.fingerprintFromHash(codeHash)}});
            const newPassword='  Nueva frase de recuperacion segura  ';
            const reset=await auth.reseetPassword({email:committed.account.email,code,password:newPassword});
            assert.equal(reset.status,200);assert.equal(reset.data.password_updated,true);
            const updated=(await q('SELECT password FROM login WHERE id_login=:id',{id:owner.id_login}))[0];
            assert.ok(updated.password.startsWith('scrypt-v1$'));assert.ok(await compare(newPassword,updated.password));
            assert.equal(await compare(committed.account.password,updated.password),false);
            assert.equal((await q('SELECT COUNT(*) n FROM session WHERE id_login=:id AND active=1',{id:owner.id_login}))[0].n,0);
            assert.equal((await auth.reseetPassword({email:committed.account.email,code,password:newPassword})).status,404);
            pass('actual login and password-reset DAO: scrypt, limited tenant, verified recovery email, preserved hash format, revoked session and one-use challenge; no mail delivered');
        } finally {
            sharedDb.query=oldDb.query;sharedDb.transaction=oldDb.transaction;security.getPasswordResetCodeSecret=oldSecret;jwtConfig.key=oldJwt;mail.SendPasswordChanged=oldMail;
            for(const [key,value] of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
        }
        if(!quiet) console.log(JSON.stringify({result:'PASS',database,server:'isolated loopback MySQL 8',pools:'two clients, max=1 each; no configured DB writes',checks},null,2));
        return {database,checks};
    } finally {await db.close();await other.close();}
}
if(require.main===module) run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

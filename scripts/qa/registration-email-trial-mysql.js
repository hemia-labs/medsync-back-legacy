'use strict';
// Synthetic schema on an explicitly selected temporary Unix socket; never the configured DB.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const mysql=require('mysql2/promise');
const {Sequelize,QueryTypes}=require('sequelize');
async function run() {
    assert.equal(process.env.REGISTRATION_QA_ISOLATED,'1');
    const socket=process.env.REGISTRATION_QA_SOCKET;
    assert.match(socket||'',/^\/private\/tmp\/medsync-[^/]+\/[^/]+\.sock$/);
    const connection=await mysql.createConnection({socketPath:socket,user:'root',password:''});
    const database='email_trial_qa_'+randomUUID().replaceAll('-','');
    let db;
    try {
        const [[instance]]=await connection.query('SELECT @@skip_networking disabled,@@datadir directory');
        assert.equal(instance.disabled,1);
        assert.ok(instance.directory.startsWith(socket.slice(0,socket.lastIndexOf('/')+1)));
        await connection.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await connection.changeUser({database});
        for(const [name,columns] of Object.entries({
            business:'id_business VARCHAR(50) PRIMARY KEY,status VARCHAR(30),subscription_status VARCHAR(30),active TINYINT,plan VARCHAR(30),trial_starts_at DATETIME,trial_ends_at DATETIME,created_by VARCHAR(50)',
            rol:'id_rol VARCHAR(50) PRIMARY KEY,code VARCHAR(30),active TINYINT',
            login:'id_login VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),id_rol VARCHAR(50),email VARCHAR(254),telephone VARCHAR(50),active TINYINT,created_by VARCHAR(50),password VARCHAR(300)'
        })) await connection.query('CREATE TABLE `'+name+'` ('+columns+') ENGINE=InnoDB');
        await connection.query(require('../migrations/s24IdentitySchema').tables.auth_identity);
        for(const sql of require('../migrations/s24ContactSchema').statements) await connection.query(sql);
        for(const sql of require('../migrations/s24ActivationSchema').statements) await connection.query(sql);
        await connection.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'../migrations/s24-registration-provisioning.sql'),'utf8'));
        await connection.query("INSERT INTO rol VALUES ('admin','admin',1)");
        const identitySchema=require('../migrations/s24IdentitySchema');
        for(const sql of [...Object.values(identitySchema.functions),...Object.values(identitySchema.procedures),...Object.values(identitySchema.triggers)]) await connection.query(sql);
        // Reproduce both old unverified states, while preserving historical and verified identities.
        for(const [id,state] of [['old-reserved','reserved'],['old-pending','pending'],['old-verified','verified'],['historical','legacy'],['old-self-legacy','legacy']]) {
            const phone='550000000'+['old-reserved','old-pending','old-verified','historical','old-self-legacy'].indexOf(id);
            await connection.query("INSERT INTO business VALUES (?,'active','pending_activation',1,NULL,NULL,NULL,?)",[id,id]);
            await connection.query("INSERT INTO login VALUES (?,?,'admin',?,?,1,?,'fixture-hash')",[id,id,id+'@example.invalid',phone,id]);
            if(id!=='historical') await connection.query('INSERT INTO registration_account(id_login,id_business) VALUES (?,?)',[id,id]);
            if(state!=='pending') await connection.query('UPDATE auth_identity SET reservation_status=?,expires_at=NULL,verified_at=? WHERE kind=\'phone\' AND id_login=?',
                [state,state==='verified'?new Date():null,id]);
        }
        const migration=require('../migrations/s27-registration-phone-contact');
        assert.equal((await migration.audit(connection)).unverifiedPhoneIdentities,3);
        const backup=socket.slice(0,socket.lastIndexOf('/'))+'/s27-backup';
        assert.equal((await migration.apply(connection,backup)).releasedPhoneIdentities,3);
        assert.equal((await migration.apply(connection,backup)).alreadyApplied,true);
        const [preserved]=await connection.query("SELECT reservation_status FROM auth_identity WHERE kind='phone' ORDER BY reservation_status");
        assert.deepEqual(preserved.map(row=>row.reservation_status),['legacy','verified']);
        await connection.query("UPDATE business SET subscription_status='trial' WHERE id_business IN ('old-reserved','old-pending')");
        await connection.query("UPDATE login SET password='changed-hash' WHERE id_login IN ('old-reserved','old-pending')");
        const [[released]]=await connection.query("SELECT COUNT(*) n FROM auth_identity WHERE kind='phone' AND id_login IN ('old-reserved','old-pending')");
        assert.equal(released.n,0,'A later account update must not recreate the released identity');
        db=new Sequelize(database,'root','',{dialect:'mysql',dialectOptions:{socketPath:socket},logging:false,pool:{min:0,max:2,idle:1000}});
        Object.assign(process.env,{REGISTRATION_IDENTITY_ENABLED:'true',REGISTRATION_ACTIVATION_ENABLED:'false',REGISTRATION_HMAC_KEY:'17'.repeat(32)});
        const {ContactVerificationService}=require('../../src/services/registration/contactVerification.service');
        const {AccountActivationService}=require('../../src/services/registration/accountActivation.service');
        const {isBusinessOperational}=require('../../src/util/businessOperational');
        const preparation=async()=>({status:200,data:{steps:[{ready:false}]}});
        const messages=[];
        let mailFails=false;
        const contacts=new ContactVerificationService(db,{ready:()=>true,send:async m=>{messages.push(m);return !mailFails;}},preparation);
        const activation=new AccountActivationService(db,preparation);
        const q=(sql,replacements={})=>db.query(sql,{replacements,type:QueryTypes.SELECT});
        const write=(sql,replacements={})=>db.query(sql,{replacements});
        async function account(id,telephone=null) {
            await write("INSERT INTO business VALUES (:id,'active','pending_activation',1,NULL,NULL,NULL,:id)",{id});
            await write("INSERT INTO login VALUES (:id,:id,'admin',:email,:telephone,1,:id,'fixture-hash')",{id,email:id+'@example.invalid',telephone});
            await write('INSERT INTO registration_account(id_login,id_business) VALUES (:id,:id)',{id});
            return {id_login:id,id_business:id};
        }
        const actor=await account('normal','5511111111');
        assert.equal((await activation.status(actor)).nextAction,'verify_contacts');
        let challenge=await contacts.request(actor,{channel:'email'},'127.0.0.1');
        const code=messages.at(-1).code;
        await assert.rejects(contacts.confirm(actor,{challengeId:challenge.challengeId,code:code==='000000'?'000001':'000000'},'127.0.0.1'),e=>e.code==='CONTACT_CODE_INVALID');
        assert.equal((await q("SELECT subscription_status FROM business WHERE id_business='normal'"))[0].subscription_status,'pending_activation');
        assert.equal((await q("SELECT reservation_status FROM auth_identity WHERE id_login='normal'"))[0].reservation_status,'pending');
        const confirmations=await Promise.all([1,2].map(()=>contacts.confirm(actor,{challengeId:challenge.challengeId,code},'127.0.0.1')));
        assert.ok(confirmations.every(result=>result.subscriptionStatus==='trial' && result.contact.emailVerified));
        assert.equal((await q("SELECT COUNT(*) n FROM auth_identity WHERE kind='phone' AND id_login='normal'"))[0].n,0);
        const [trial]=await q("SELECT *,TIMESTAMPDIFF(SECOND,trial_starts_at,trial_ends_at) duration FROM business WHERE id_business='normal'");
        assert.equal(trial.duration,15*24*60*60);
        assert.equal(trial.plan,'pro');
        const {getSaasPlan}=require('../../src/config/saasPlans');
        const {getEffectiveDashboardCapabilities}=require('../../src/config/dashboardCapabilities');
        assert.equal(getSaasPlan(trial.plan).maxAuxiliaryUsers,3);
        assert.equal(getSaasPlan('professional').code,'pro');
        assert.equal(getEffectiveDashboardCapabilities('professional').fallbackApplied,false);
        assert.equal(getEffectiveDashboardCapabilities('professional').capabilities.trends,true);
        assert.ok(isBusinessOperational(trial).allowed);
        assert.equal((await activation.status(actor)).destination,'summary');
        assert.equal((await activation.acknowledge(actor,{acknowledged:true})).acknowledged,true);
        assert.equal((await activation.status(actor)).destination,'home');
        await contacts.confirm(actor,{challengeId:challenge.challengeId,code},'127.0.0.1');
        const [unchanged]=await q("SELECT trial_starts_at,trial_ends_at FROM business WHERE id_business='normal'");
        assert.equal(+unchanged.trial_starts_at,+trial.trial_starts_at);
        assert.equal(+unchanged.trial_ends_at,+trial.trial_ends_at);
        await assert.rejects(contacts.request(actor,{channel:'email'},'127.0.0.1'),e=>e.code==='CONTACT_ALREADY_VERIFIED');
        await write("UPDATE business SET trial_ends_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id_business='normal'");
        assert.equal((await activation.status(actor)).destination,'restricted');
        assert.equal(isBusinessOperational((await q("SELECT * FROM business WHERE id_business='normal'"))[0]).reasonCode,'TRIAL_EXPIRED');
        await contacts.confirm(actor,{challengeId:challenge.challengeId,code},'127.0.0.1');
        assert.equal((await activation.status(actor)).destination,'restricted');
        await assert.rejects(contacts.confirm({id_login:'normal',id_business:'foreign'},{challengeId:challenge.challengeId,code},'127.0.0.1'),e=>e.code==='ACTIVATION_FORBIDDEN');
        const expired=await account('expired');
        challenge=await contacts.request(expired,{channel:'email'},'127.0.0.1');
        await write('UPDATE registration_contact_challenge SET expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE challenge_id=:id',{id:challenge.challengeId});
        await assert.rejects(contacts.confirm(expired,{challengeId:challenge.challengeId,code:messages.at(-1).code},'127.0.0.1'),e=>e.code==='CONTACT_CODE_INVALID');
        assert.equal((await activation.status(expired)).subscriptionStatus,'pending_activation');
        const rollback=await account('rollback');
        challenge=await contacts.request(rollback,{channel:'email'},'127.0.0.1');
        await write("CREATE TRIGGER fail_activation BEFORE INSERT ON registration_account FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic activation failure'");
        await assert.rejects(contacts.confirm(rollback,{challengeId:challenge.challengeId,code:messages.at(-1).code},'127.0.0.1'));
        await write('DROP TRIGGER fail_activation');
        assert.equal((await q("SELECT reservation_status FROM auth_identity WHERE id_login='rollback'"))[0].reservation_status,'pending');
        assert.equal((await q("SELECT status FROM registration_contact_challenge WHERE id_login='rollback'"))[0].status,'sent');
        assert.equal((await activation.status(rollback)).subscriptionStatus,'pending_activation');
        const failed=await account('mail-failure');mailFails=true;
        await assert.rejects(contacts.request(failed,{channel:'email'},'127.0.0.1'),e=>e.code==='CONTACT_PROVIDER_UNAVAILABLE');
        assert.equal((await activation.status(failed)).subscriptionStatus,'pending_activation');
        // Recovery already proves email ownership; it must not need another contact code.
        const recovered=await account('recovered');
        async function recover(actor,fail=false) {
            return db.transaction(async tx=>{
                await db.query(`UPDATE auth_identity SET reservation_status='verified',verified_at=NOW(3),expires_at=NULL
                    WHERE id_login=:login AND kind='email'`,{replacements:{login:actor.id_login},transaction:tx});
                const result=await activation.activateVerifiedEmail(actor.id_login,tx);
                if(fail) throw Error('synthetic recovery rollback');
                return result;
            });
        }
        await assert.rejects(recover(recovered,true),/synthetic recovery rollback/);
        assert.equal((await activation.status(recovered)).nextAction,'verify_contacts');
        assert.equal((await q("SELECT reservation_status FROM auth_identity WHERE id_login='recovered'"))[0].reservation_status,'pending');
        assert.equal(await recover(recovered),true);
        assert.equal((await activation.status(recovered)).nextAction,'setup_summary');
        const [recoveryTrial]=await q("SELECT *,TIMESTAMPDIFF(SECOND,trial_starts_at,trial_ends_at) duration FROM business WHERE id_business='recovered'");
        assert.equal(recoveryTrial.duration,15*24*60*60);
        assert.equal(recoveryTrial.plan,'pro');
        assert.equal(await recover(recovered),false);
        assert.deepEqual((await q("SELECT trial_starts_at,trial_ends_at FROM business WHERE id_business='recovered'"))[0],
            {trial_starts_at:recoveryTrial.trial_starts_at,trial_ends_at:recoveryTrial.trial_ends_at});
        for(const status of ['active','trial','past_due','suspended','cancelled','legacy']) {
            const existing=await account('existing-'+status);
            await write('UPDATE business SET subscription_status=:status,plan=\'basic\' WHERE id_business=:id',{status,id:existing.id_business});
            assert.equal(await recover(existing),false);
            assert.equal((await q('SELECT subscription_status FROM business WHERE id_business=:id',{id:existing.id_business}))[0].subscription_status,status);
        }
        const foreignOwner=await account('not-self-registration');
        await write("UPDATE business SET created_by='another-owner' WHERE id_business=:id",{id:foreignOwner.id_business});
        assert.equal(await recover(foreignOwner),false);
        const unverified=await account('unverified');
        assert.equal(await db.transaction(tx=>activation.activateVerifiedEmail(unverified.id_login,tx)),false);
        const sharedPhone='5512345678';
        const phoneA=await account('phone-a',sharedPhone),phoneB=await account('phone-b',sharedPhone);
        assert.equal((await q("SELECT COUNT(*) n FROM auth_identity WHERE kind='phone' AND normalized_value=:phone",{phone:sharedPhone}))[0].n,0);
        const {findOwner}=require('../../src/services/registration/identityAuth');
        assert.equal(await findOwner(db,sharedPhone,{allowExpired:true}),null);
        await contacts.replace(phoneB,{channel:'sms',value:'5500000003'},'127.0.0.1');
        assert.equal((await findOwner(db,'5500000003')).id_login,'historical','Changing a contact cannot replace a historical owner');
        assert.equal(await recover(phoneA),true);
        await write("UPDATE login SET password='new-hash' WHERE id_login='phone-a'");
        assert.equal((await q("SELECT COUNT(*) n FROM auth_identity WHERE kind='phone' AND normalized_value=:phone",{phone:sharedPhone}))[0].n,0);
        assert.equal((await findOwner(db,'phone-a@example.invalid')).id_login,'phone-a');
        assert.equal((await findOwner(db,'5500000002')).id_login,'old-verified');
        // A privileged historical writer can claim this number; a contact field cannot block it.
        await write("INSERT INTO login VALUES ('real-phone-owner','historical','admin','real-owner@example.invalid',:phone,1,'historical','fixture-hash')",{phone:sharedPhone});
        assert.equal((await findOwner(db,sharedPhone)).id_login,'real-phone-owner');
        assert.equal((await findOwner(db,'phone-a@example.invalid')).id_login,'phone-a');
        await assert.rejects(write("UPDATE login SET email='phone-a@example.invalid' WHERE id_login='phone-b'"),
            error=>(error.original||error.parent||error).sqlMessage==='REG_IDENTITY_CONFLICT');
        // Even an accidentally restored pending status must not grant a second trial.
        await write("UPDATE business SET subscription_status='pending_activation',trial_starts_at=NULL,trial_ends_at=NULL WHERE id_business='recovered'");
        assert.equal(await recover(recovered),false);
        console.log('PASS recovery activation SQL: first trial, exact duration, same-transaction rollback, no renewal, existing subscriptions and unrelated owners unchanged.');
        console.log('PASS phone contact policy: S27 cleanup/idempotence; no claims on registration, email activation, recovery, contact correction or later updates; shared contacts allowed; historical/verified phone login and email login preserved.');
        console.log('PASS: real MySQL — wrong/expired codes, email failure, atomic rollback, tenant isolation, concurrent confirmation, 15-day trial, welcome, expiration and no restart; legacy commercial flag disabled.');
    } finally {
        if(db)await db.close();
        await connection.query('DROP DATABASE IF EXISTS `'+database+'`');
        await connection.end();
    }
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

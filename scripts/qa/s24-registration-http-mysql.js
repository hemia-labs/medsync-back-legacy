'use strict';
// Runs only on the same dedicated synthetic MySQL server as R2-B.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {Sequelize,QueryTypes}=require('sequelize');
const express=require('express'),cookies=require('cookie-parser');
async function run() {
    if(process.env.S24_QA_ISOLATED!=='1')throw Error('Isolated QA opt-in required');
    const base=await require('./s24-provisioning-mysql').run({quiet:true});
    const port=Number(process.env.S24_QA_PORT||33324);
    const connect=()=>new Sequelize(base.database,'root','',{host:'127.0.0.1',port,dialect:'mysql',logging:false,pool:{max:1,min:0,idle:1000}});
    const db=connect(),other=connect();
    const checks=[],pass=s=>checks.push(s);
    const q=(sql,replacements={})=>db.query(sql,{replacements,type:/^\s*SELECT\b/i.test(sql)?QueryTypes.SELECT:QueryTypes.RAW});
    const sharedDb=require('../../src/db/Sequelize.connection'),oldDb={query:sharedDb.query,transaction:sharedDb.transaction};
    const security=require('../../src/config/security'),jwtConfig=require('../../src/config/jwt');
    const oldSecurity={csrf:security.getCsrfTokenSecret,refresh:security.getRefreshTokenSecret},oldJwt={key:jwtConfig.key,expiresIn:jwtConfig.expiresIn};
    const savedEnv={...process.env};let server;
    const originalInfo=console.info,logs=[];console.info=(...parts)=>logs.push(parts.join(' '));
    try {
        for(const sql of require('../migrations/s24ContactSchema').statements)await db.query(sql);
        const policy=JSON.stringify({version:'qa-only-v1',source:'Synthetic QA only',license:'Original fixtures',passwords:['a common password for tests']});
        const policyPath=path.resolve(__dirname,'../../../_qa/s24-r2',base.database+'-r2c-policy.json');await fs.writeFile(policyPath,policy);
        Object.assign(process.env,{REGISTRATION_ENABLED:'true',REGISTRATION_IDENTITY_ENABLED:'true',REGISTRATION_HMAC_KEY:'19'.repeat(32),
            REGISTRATION_PASSWORD_BLOCKLIST_PATH:policyPath,REGISTRATION_PASSWORD_BLOCKLIST_SHA256:createHash('sha256').update(policy).digest('hex'),
            AUTH_COOKIE_MODE:'d2',BROWSER_AUTH_TRANSPORT:'cookie',AUTH_COOKIE_SECURE:'false',AUTH_COOKIE_DOMAIN:'',AUTH_COOKIE_PATH:'/',
            AUTH_COOKIE_ACCESS_NAME:'s24_qa_at',AUTH_COOKIE_REFRESH_NAME:'s24_qa_rt',AUTH_CSRF_COOKIE_NAME:'s24_qa_csrf',CSRF_COOKIE_NAME:'s24_qa_csrf',
            AUTH_COOKIE_SAMESITE:'lax',CSRF_ENABLED:'true',CSRF_ORIGIN_CHECK_ENABLED:'true',CORS_CREDENTIALS:'true',NODE_ENV:'test',APP_ENV:'test'});
        security.getCsrfTokenSecret=()=> 'synthetic-csrf-r2c';security.getRefreshTokenSecret=()=> 'synthetic-refresh-r2c';
        jwtConfig.key='synthetic-jwt-r2c';jwtConfig.expiresIn={expiresIn:'15m'};
        sharedDb.query=(...args)=>db.query(...args);sharedDb.transaction=(...args)=>db.transaction(...args);
        const deliveries=[];let deliveryFails=false,sessionFails=false;
        const {ContactDelivery}=require('../../src/services/registration/contactDelivery');
        const delivery=new ContactDelivery({email:{ready:()=>true,send:async message=>{
            // Real SQL proves the transaction has already committed before dispatch.
            const [persisted]=await q('SELECT status FROM registration_contact_challenge WHERE challenge_id=:id',{id:message.challengeId});
            assert.equal(persisted.status,'sending');deliveries.push(message);return !deliveryFails;
        }}});
        const {createRouter}=require('../../src/routes/mysql/registration');
        const auth=require('../../src/Dao/mysql/auth.dao');
        const app=express();app.use(cookies());app.use(require('../../src/middleware/requestBody.middleware').defaultBodyParser);
        app.use('/api',createRouter({database:db,delivery,login:async(...args)=>sessionFails?{status:503}:auth.login(...args)}));
        app.use('/api/auth',require('../../src/routes/mysql/auth'));
        app.get('/api/clinical',require('../../src/auth/authenticate').Auth,(req,res)=>res.json({forbiddenLeak:true}));
        app.use((error,req,res,next)=>res.status(500).json({code:'QA_UNEXPECTED_ERROR'}));
        server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
        const origin='http://127.0.0.1:'+server.address().port;
        process.env.CORS_ALLOWED_ORIGINS=origin;process.env.CSRF_ALLOWED_ORIGINS=origin;
        const jar=()=>new Map();
        const contract=require('../../../docs/saas-platform/registration/registration.openapi.json');
        const Ajv=require('../../../hemia-assistance-front-legacy/node_modules/ajv');
        const ajv=new Ajv({allErrors:true,unknownFormats:'ignore',nullable:true});
        const definitions=JSON.parse(JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/','#/definitions/'));
        const validate=Object.fromEntries(['Context','Registered','Activation','Plans','VerificationChallenge','Error'].map(name=>[name,ajv.compile({definitions,$ref:'#/definitions/'+name})]));
        async function request(j,method,route,body,headers={},autoCsrf=true) {
            const sent={Origin:origin,...headers};
            if(j.size)sent.Cookie=[...j].map(([k,v])=>k+'='+v).join('; ');
            if(body!==undefined)sent['Content-Type']='application/json';
            if(autoCsrf&&j.has('s24_qa_csrf'))sent['X-CSRF-Token']=decodeURIComponent(j.get('s24_qa_csrf'));
            const response=await fetch(origin+route,{method,headers:sent,body:body===undefined?undefined:JSON.stringify(body)});
            const sets=response.headers.getSetCookie();for(const cookie of sets){const pair=cookie.split(';')[0],index=pair.indexOf('=');j.set(pair.slice(0,index),pair.slice(index+1));}
            const data=await response.json();
            const shape=route==='/api/registration/context'?'Context':route==='/api/auth/register'?'Registered':route==='/api/account/activation/plans'?'Plans':route==='/api/account/contact-verifications'?'VerificationChallenge':route.startsWith('/api/account/')?'Activation':null;
            if(response.ok&&shape)assert.equal(validate[shape](data),true,JSON.stringify(validate[shape].errors));
            if(!response.ok&&shape)assert.equal(validate.Error(data),true,JSON.stringify(validate.Error.errors));
            return {status:response.status,body:data,sets,headers:response.headers};
        }
        let seq=100;
        const payload=context=>({account:{name:'QA correo',telephone:'556'+String(seq++).padStart(7,'0'),email:'r2c'+seq+'@example.test',password:' Clave extensa de prueba privada '+seq+' '},
            business:{name:'Consultorio R2C'},legalAcceptances:context.legalDocuments.map(d=>({documentKey:d.documentKey,versionId:d.versionId,acknowledged:true}))});
        const a=jar();process.env.REGISTRATION_ENABLED='false';
        let response=await request(a,'GET','/api/registration/context');assert.equal(response.body.enabled,false);assert.equal(a.size,0);
        process.env.REGISTRATION_ENABLED='true';
        response=await request(a,'GET','/api/registration/context');assert.equal(response.status,200);assert.equal(response.body.enabled,true,JSON.stringify(response.body));
        assert.deepEqual(response.body.verificationChannels,['email']);assert.equal(response.body.legalDocuments.length,2);
        assert.ok(response.sets.some(s=>s.startsWith('medsync_registration_dev=')&&s.includes('HttpOnly')&&s.includes('SameSite=Strict')));
        const originalAttempt=a.get('medsync_registration_dev');const context=response.body;
        await request(a,'GET','/api/registration/context');assert.equal(a.get('medsync_registration_dev'),originalAttempt);
        const input=payload(context),attempt=randomUUID(),headers={'Idempotency-Key':attempt};
        assert.equal((await request(a,'POST','/api/auth/register',input,headers,false)).status,403);
        assert.equal((await request(a,'POST','/api/auth/register',input,{...headers,Origin:'https://evil.example'})).status,403);
        const forged=new Map(a);forged.set('medsync_registration_dev','forged');
        assert.equal((await request(forged,'POST','/api/auth/register',input,headers)).status,400);
        assert.equal((await request(a,'POST','/api/auth/register',{...input,role:'super_admin'},headers)).status,400);
        assert.equal((await request(a,'POST','/api/auth/register',{...input,big:'x'.repeat(9000)},headers)).status,413);
        pass('public gate, published context, protected attempt cookie, stable expiry, real CSRF/origin and 8 KiB/whitelist rejection');
        const preauth=new Map(a);
        response=await request(a,'POST','/api/auth/register',input,headers);
        assert.equal(response.status,201,JSON.stringify(response.body));assert.equal(response.body.sessionEstablished,true,JSON.stringify(response.body));
        const actor={id_login:response.body.activation.accountId,id_business:response.body.activation.businessId};
        assert.ok(a.has('s24_qa_at')&&a.has('s24_qa_rt'));
        assert.ok(response.sets.filter(s=>s.startsWith('s24_qa_at=')||s.startsWith('s24_qa_rt=')).every(s=>s.includes('HttpOnly')));
        assert.ok(!/password|refresh_token|csrfToken|"token"/.test(JSON.stringify(response.body)));
        assert.equal(response.body.activation.subscriptionStatus,'pending_activation');
        response=await request(a,'GET','/api/account/activation');assert.equal(response.status,200);assert.deepEqual(response.body.contact.requiredChannels,['email']);
        assert.equal((await request(a,'GET','/api/clinical')).status,403);
        assert.equal((await request(a,'GET','/api/account/activation?id_business=foreign')).status,400);
        assert.equal((await request(a,'POST','/api/auth/register',input,headers)).status,409);
        assert.equal((await request(a,'GET','/api/account/activation/plans')).body.available,false);
        pass('actual SQL login after commit, HttpOnly access/refresh, rotated session CSRF, limited tenant, no tokens in response and authenticated signup rejected');
        const before=(await q('SELECT COUNT(*) n FROM business'))[0].n;
        const replay=new Map(preauth);response=await request(replay,'POST','/api/auth/register',input,headers);
        assert.equal(response.status,200);assert.equal(response.body.sessionEstablished,true);assert.equal((await q('SELECT COUNT(*) n FROM business'))[0].n,before);
        assert.equal((await request(new Map(preauth),'POST','/api/auth/register',{...input,business:{name:'Changed'}},headers)).status,409);
        pass('HTTP replay proves credentials and reissues session without duplicate business; changed payload conflicts');
        // Existing login SP maintains one active session, so use latest cookies.
        a.clear();for(const pair of replay)a.set(...pair);
        const wrongContext=new Map(a);wrongContext.set('s24_qa_csrf',preauth.get('s24_qa_csrf'));
        assert.equal((await request(wrongContext,'POST','/api/account/contact-verifications',{channel:'email'})).status,403);
        assert.equal((await request(a,'POST','/api/account/contact-verifications',{channel:'sms'})).status,503);
        response=await request(a,'POST','/api/account/contact-verifications',{channel:'email'});assert.equal(response.status,202,JSON.stringify(response.body));
        const firstId=response.body.challengeId,firstDelivery=deliveries.at(-1);
        assert.equal(firstDelivery.to,input.account.email);assert.equal(firstDelivery.purpose,'registration_contact');
        const stored=(await q('SELECT * FROM registration_contact_challenge WHERE challenge_id=:id',{id:firstId}))[0];
        assert.equal(stored.code_hash.length,64);assert.ok(!Object.values(stored).includes(firstDelivery.code));assert.ok(!Object.values(stored).includes(input.account.email));
        response=await request(a,'POST','/api/account/contact-verifications',{channel:'email'});assert.equal(response.status,429);assert.ok(Number(response.headers.get('retry-after'))>0);
        const wrong=firstDelivery.code==='000000'?'999999':'000000';
        for(let i=0;i<5;i++)assert.equal((await request(a,'POST','/api/account/contact-verifications/confirm',{challengeId:firstId,code:wrong})).status,400);
        assert.equal((await q('SELECT guesses,status FROM registration_contact_challenge WHERE challenge_id=:id',{id:firstId}))[0].guesses,5);
        assert.equal((await request(a,'POST','/api/account/contact-verifications/confirm',{challengeId:firstId,code:firstDelivery.code})).status,400);
        pass('email-only delivery after commit; durable HMAC, cooldown/Retry-After, five wrong guesses committed and locked; preauth CSRF cannot mutate session contacts');
        await q('UPDATE registration_contact_challenge SET created_at=DATE_SUB(NOW(3),INTERVAL 61 SECOND) WHERE challenge_id=:id',{id:firstId});
        response=await request(a,'POST','/api/account/contact-verifications',{channel:'email'});assert.equal(response.status,202);
        const challenge=response.body.challengeId,code=deliveries.at(-1).code;
        const b=jar(),ctxB=(await request(b,'GET','/api/registration/context')).body,inputB=payload(ctxB);
        response=await request(b,'POST','/api/auth/register',inputB,{'Idempotency-Key':randomUUID()});assert.equal(response.status,201);
        assert.equal((await request(b,'POST','/api/account/contact-verifications/confirm',{challengeId:challenge,code})).status,400);
        const confirmed=await Promise.all([request(a,'POST','/api/account/contact-verifications/confirm',{challengeId:challenge,code}),request(a,'POST','/api/account/contact-verifications/confirm',{challengeId:challenge,code})]);
        assert.deepEqual(confirmed.map(r=>r.status).sort(),[200,400]);
        const state=confirmed.find(r=>r.status===200).body;assert.equal(state.contact.emailVerified,true);assert.equal(state.contact.telephoneVerified,false);assert.equal(state.nextAction,'unavailable');
        const phone=(await q("SELECT * FROM auth_identity WHERE kind='phone' AND id_login=:id",{id:actor.id_login}))[0];
        assert.equal(phone.reservation_status,'reserved');assert.equal(phone.verified_at,null);assert.equal(phone.expires_at,null);
        assert.equal((await request(a,'PATCH','/api/account/activation/contact',{channel:'email',value:'other@example.test'})).status,409);
        assert.equal((await request(a,'PATCH','/api/account/activation/contact',{channel:'sms',value:inputB.account.telephone})).status,409);
        const newPhone='5570000100';response=await request(a,'PATCH','/api/account/activation/contact',{channel:'sms',value:newPhone});assert.equal(response.status,200);
        assert.equal((await q("SELECT reservation_status FROM auth_identity WHERE kind='phone' AND normalized_value=:phone",{phone:newPhone}))[0].reservation_status,'reserved');
        pass('cross-account challenge denied; concurrent single-use confirmation; email verified with phone reserved but NOT verified; protected email and unique phone correction');
        // Failed session issuance preserves the account, and the original attempt can recover it.
        const c=jar(),ctxC=(await request(c,'GET','/api/registration/context')).body,inputC=payload(ctxC),attemptC=randomUUID();
        const preauthC=new Map(c);
        sessionFails=true;response=await request(c,'POST','/api/auth/register',inputC,{'Idempotency-Key':attemptC});assert.equal(response.status,201);assert.equal(response.body.sessionEstablished,false);assert.equal(c.has('s24_qa_at'),false);
        sessionFails=false;response=await request(c,'POST','/api/auth/register',inputC,{'Idempotency-Key':attemptC});assert.equal(response.status,200);assert.equal(response.body.sessionEstablished,true);
        deliveryFails=true;response=await request(c,'POST','/api/account/contact-verifications',{channel:'email'});assert.equal(response.status,503);
        const failedDelivery=deliveries.at(-1);assert.equal((await request(c,'POST','/api/account/contact-verifications/confirm',{challengeId:failedDelivery.challengeId,code:failedDelivery.code})).status,400);
        deliveryFails=false;
        pass('post-commit session failure recoverable through same attempt; unknown/failed delivery does not verify and has no automatic resend');
        // Correcting an unverified email invalidates outstanding codes and reserves the new address.
        response=await request(b,'POST','/api/account/contact-verifications',{channel:'email'});assert.equal(response.status,202);
        const beforeCorrection=deliveries.at(-1);
        response=await request(b,'PATCH','/api/account/activation/contact',{channel:'email',value:'corrected-r2c@example.test'});assert.equal(response.status,200);
        assert.equal(response.body.contact.emailVerified,false);
        assert.equal((await request(b,'POST','/api/account/contact-verifications/confirm',{challengeId:beforeCorrection.challengeId,code:beforeCorrection.code})).status,400);
        await q('UPDATE registration_contact_challenge SET created_at=DATE_SUB(NOW(3),INTERVAL 61 SECOND) WHERE challenge_id=:id',{id:beforeCorrection.challengeId});
        response=await request(b,'POST','/api/account/contact-verifications',{channel:'email'});assert.equal(response.status,202);
        const expiring=deliveries.at(-1);assert.equal(expiring.to,'corrected-r2c@example.test');
        await q('UPDATE registration_contact_challenge SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE challenge_id=:id',{id:expiring.challengeId});
        assert.equal((await request(b,'POST','/api/account/contact-verifications/confirm',{challengeId:expiring.challengeId,code:expiring.code})).status,400);
        pass('email correction invalidates previous code and reserves new destination; expired challenge fails without verifying');
        response=await request(a,'GET','/api/auth/session');assert.equal(response.status,200);assert.equal(response.body.data.authenticated,true);
        response=await request(a,'POST','/api/auth/refreshToken',{});assert.equal(response.status,200,JSON.stringify(response.body));
        assert.equal((await request(a,'GET','/api/account/activation')).status,200);
        response=await request(a,'PUT','/api/auth/close',{});assert.equal(response.status,200);
        assert.equal((await request(a,'GET','/api/account/activation')).status,401);
        pass('common D2 session hydration, real refresh rotation and logout remain usable after registration and phone correction');
        const {RegistrationRateLimit}=require('../../src/services/registration/registrationRateLimit');
        const limits=[['qa-concurrent',randomUUID(),1,3600]];
        const race=await Promise.allSettled([new RegistrationRateLimit(db).consume(limits),new RegistrationRateLimit(other).consume(limits)]);
        assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.find(r=>r.status==='rejected').reason.status,429);
        pass('shared MySQL quota serializes different clients; one admitted, one 429');
        // Resume an expired but still-owned username only after checking the password.
        await q("UPDATE auth_identity SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE kind='phone' AND normalized_value=:phone",{phone:inputC.account.telephone});
        assert.equal((await request(c,'GET','/api/account/activation')).status,401);
        assert.equal((await auth.login({param:inputC.account.telephone,pwd:'wrong password value',refresh:false})).status,404);
        assert.equal((await q("SELECT expires_at<=NOW(3) expired FROM auth_identity WHERE kind='phone' AND normalized_value=:phone",{phone:inputC.account.telephone}))[0].expired,1);
        assert.equal((await auth.login({param:inputC.account.telephone,pwd:inputC.account.password,refresh:false})).status,200);
        assert.equal((await q("SELECT expires_at>NOW(3) renewed FROM auth_identity WHERE kind='phone' AND normalized_value=:phone",{phone:inputC.account.telephone}))[0].renewed,1);
        pass('expired session rejected; wrong password cannot renew username; correct current-owner password reclaims only its expired reservation');
        const freshHash=await require('../../src/services/security/registrationPassword.service').hash('Una clave nueva posterior al registro');
        await q('UPDATE login SET password=:hash WHERE telephone=:phone',{hash:freshHash,phone:inputC.account.telephone});
        response=await request(new Map(preauthC),'POST','/api/auth/register',inputC,{'Idempotency-Key':attemptC});
        assert.equal(response.status,200);assert.equal(response.body.sessionEstablished,false);assert.equal(response.sets.length,0);
        pass('old idempotent payload cannot authenticate after the account password has changed');
        const newerHash=await require('../../src/services/security/registrationPassword.service').hash('Otra clave cambiada durante el login');
        let interrupted=false;
        sharedDb.query=async(sql,...args)=>{
            if(!interrupted && String(sql).includes('SP_login_by_idlogin')) {
                interrupted=true;await q('UPDATE login SET password=:hash WHERE telephone=:phone',{hash:newerHash,phone:inputC.account.telephone});
            }
            return db.query(sql,...args);
        };
        try {
            const racedLogin=await auth.login({param:inputC.account.telephone,pwd:'Una clave nueva posterior al registro',refresh:true});
            assert.equal(interrupted,true);assert.equal(racedLogin.status,404);
            const [current]=await q('SELECT id_login FROM login WHERE telephone=:phone',{phone:inputC.account.telephone});
            assert.equal((await q('SELECT COUNT(*) n FROM session WHERE id_login=:id AND active=1',{id:current.id_login}))[0].n,0);
            assert.equal((await q('SELECT COUNT(*) n FROM refresh_token WHERE id_login=:id AND revoked_at IS NULL AND last=1',{id:current.id_login}))[0].n,0);
        } finally {sharedDb.query=(...args)=>db.query(...args);}
        pass('password change during login denies issuance and revokes the session and refresh created by the legacy procedure');
        const cleanup=await require('mysql2/promise').createConnection({host:'127.0.0.1',port,user:'root',password:'',database:base.database});
        try {
            const preflight=await require('../migrations/s24-registration-contact').preflight(cleanup);
            assert.equal(preflight.reservedState,true);assert.equal(preflight.contactTables.length,2);assert.equal(preflight.ready,false);
            const counts=async()=>({business:(await q('SELECT COUNT(*) n FROM business'))[0].n,legal:(await q('SELECT COUNT(*) n FROM saas_legal_acceptances'))[0].n});
            const preserved=await counts();
            await q('UPDATE registration_attempt SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND)');
            await q('UPDATE registration_contact_challenge SET expires_at=DATE_SUB(NOW(3),INTERVAL 25 HOUR) WHERE challenge_id=:id',{id:failedDelivery.challengeId});
            const deleted=await require('../maintenance/s24-registration-retention').prune(cleanup);
            assert.ok(deleted.registration_attempt>0);assert.ok(deleted.registration_contact_challenge>0);assert.deepEqual(await counts(),preserved);
            // Account authorization is durable and does not depend on expired idempotency receipts.
            const {ContactVerificationService}=require('../../src/services/registration/contactVerification.service');
            assert.equal((await new ContactVerificationService(db,delivery).status(actor)).contact.emailVerified,true);
        } finally {await cleanup.end();}
        assert.ok(logs.every(line=>!line.includes(input.account.password)&&!line.includes(inputC.account.password)));
        pass('migration guards detect applied schema; bounded retention removes expired technical records while preserving accounts, legal evidence and activation access');
        console.log(JSON.stringify({result:'PASS',database:base.database,server:'isolated loopback MySQL 8',r2bGroups:base.checks.length,groups:checks.length,checks,
            scope:'real HTTP, cookies, CSRF, session/auth DAO and SQL; delivery doubles only; no live emails, payments or configured DB writes'},null,2));
    } finally {
        if(server)await new Promise(resolve=>server.close(resolve));
        sharedDb.query=oldDb.query;sharedDb.transaction=oldDb.transaction;
        security.getCsrfTokenSecret=oldSecurity.csrf;security.getRefreshTokenSecret=oldSecurity.refresh;jwtConfig.key=oldJwt.key;jwtConfig.expiresIn=oldJwt.expiresIn;
        for(const key of Object.keys(process.env))if(!(key in savedEnv))delete process.env[key];Object.assign(process.env,savedEnv);
        console.info=originalInfo;
        await db.close();await other.close();
    }
}
run().catch(error=>{console.error(error.name+': '+error.message);console.error(String(error.stack).split('\n').filter(line=>/^\s+at /.test(line)).join('\n'));process.exitCode=1;});

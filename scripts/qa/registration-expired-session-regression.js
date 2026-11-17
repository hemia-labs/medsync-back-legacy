'use strict';
// Actual optional authentication, registration routes, cookie and CSRF contracts.
// Database, delivery and account creation are doubles; no external services.
const assert=require('node:assert/strict');
const express=require('express'),cookies=require('cookie-parser'),jwt=require('jsonwebtoken');
const stub=(file,exports)=>{const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};};
Object.assign(process.env,{NODE_ENV:'test',APP_ENV:'test',REGISTRATION_ENABLED:'true',REGISTRATION_IDENTITY_ENABLED:'true',
    REGISTRATION_HMAC_KEY:'19'.repeat(32),AUTH_COOKIE_MODE:'d2',BROWSER_AUTH_TRANSPORT:'cookie',AUTH_COOKIE_SECURE:'false',
    AUTH_COOKIE_DOMAIN:'',AUTH_COOKIE_PATH:'/',AUTH_COOKIE_ACCESS_NAME:'qa_at',AUTH_COOKIE_REFRESH_NAME:'qa_rt',
    AUTH_CSRF_COOKIE_NAME:'qa_csrf',CSRF_COOKIE_NAME:'qa_csrf',AUTH_COOKIE_SAMESITE:'lax',JWT_EXPIRES_IN:'15m',
    CSRF_ENABLED:'true',CSRF_ORIGIN_CHECK_ENABLED:'true',CORS_CREDENTIALS:'true',CORS_ALLOWED_ORIGINS:'http://qa.invalid'});
let refreshActive=false,failDatabase=false,principalActive=true,creates=0,attempts=[];
const database={async query(sql){
    if(failDatabase)throw Error('synthetic database outage');
    if(sql.includes('FROM refresh_token rt')) {assert.match(sql,/revoked_at IS NULL/);assert.match(sql,/rotated_at IS NULL/);assert.match(sql,/expires_at>NOW\(\)/);return refreshActive?[{id_refresh_token:'synthetic'}]:[];}
    if(sql.includes('FROM login l'))return principalActive?[{id_login:'qa',id_session:'qa-session',id_business:'qa-business',rol:'admin',subscription_status:'trial'}]:[];
    throw Error('Unexpected SQL');
}};
stub('../../src/db/Sequelize.connection',database);
stub('../../src/Dao/mysql/auth.dao',{});
stub('../../src/controller/mysql/auth.controller',{applyD2LoginCookies(){throw Error('Unexpected login');}});
stub('../../src/services/security/securityLogger.service',{record(){}});
stub('../../src/services/registration/registrationRateLimit',{RegistrationRateLimit:class{async consume(){}}});
stub('../../src/services/registration/contactVerification.service',{ContactVerificationService:class{async status(){return {};}}});
const passwords=require('../../src/services/security/registrationPassword.service');passwords.configuredBlocklist=async()=>[];
const security=require('../../src/config/security');security.getCsrfTokenSecret=()=> 'qa-csrf-only';security.getRefreshTokenSecret=()=> 'qa-refresh-only';
require('../../src/config/jwt').key='qa-signing-only';
const csrf=require('../../src/services/security/csrfToken.service');
const attempt=require('../../src/services/registration/registrationSecurity');
const auth=require('../../src/auth/authenticate');
const {createRouter}=require('../../src/routes/mysql/registration');
const input={account:{first_name:'QA',first_surname:'Sintética',second_surname:'',last_name:'Sintética',telephone:'',email:'qa@example.invalid',password:'Synthetic test phrase 123!'},business:{name:'Synthetic clinic'},legalContext:'synthetic',legalAcceptances:[{documentKey:'terms',versionId:'v1',acknowledged:true}]};
const app=express();app.use(cookies());app.use(require('../../src/middleware/requestBody.middleware').defaultBodyParser);
app.use('/api',createRouter({database,delivery:{ready:()=>true},legal:{ready:async()=>{},context:async()=>({legalDocuments:[],legalContext:'synthetic'})},
    registration:{create:async(source,receipt)=>{require('../../src/services/registration/registration.validator').validateRegistration(source);creates++;attempts.push(receipt);return {success:true,status:201,data:{idLogin:'qa-created',idBusiness:'qa-new'}};}},login:async()=>({status:503})}));
app.get('/api/qa/csrf',auth.OptionalAuth,(req,res)=>{const token=csrf.issueToken(req);res.cookie('qa_csrf',token.token,csrf.csrfCookieOptions());res.json({ok:true});});
app.use((error,req,res,next)=>res.status(503).json({code:'REGISTRATION_UNAVAILABLE'}));
(async()=>{
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const origin='http://127.0.0.1:'+server.address().port;process.env.CORS_ALLOWED_ORIGINS=origin;process.env.CSRF_ALLOWED_ORIGINS=origin;
    const access=expired=>jwt.sign({id_login:'qa',id_session:'qa-session',id_business:'qa-business',rol:'admin'},'qa-signing-only',{expiresIn:expired?-60:600});
    const jar=(expired=true)=>new Map([['qa_at',access(expired)],['qa_rt','v2.77777777-7777-4777-8777-777777777777.'+'x'.repeat(43)]]);
    async function request(j,method,url,body={},options={}) {
        const headers={origin:options.origin||origin,cookie:[...j].map(([k,v])=>k+'='+v).join('; ')};
        if(method!=='GET'){headers['content-type']='application/json';headers['Idempotency-Key']='66666666-6666-4666-8666-666666666666';if(!options.noCsrf)headers['X-CSRF-Token']=j.get('qa_csrf')||'';}
        const response=await fetch(origin+url,{method,headers,...(method==='GET'?{}:{body:JSON.stringify(body)})});
        const set=response.headers.getSetCookie();for(const c of set){const pair=c.split(';')[0],at=pair.indexOf('=');j.set(pair.slice(0,at),decodeURIComponent(pair.slice(at+1)));}
        return {status:response.status,body:await response.json(),set};
    }
    try {
        const stale=jar();let result=await request(stale,'GET','/api/registration/context');assert.equal(result.body.sessionState,'expired');
        const originalAttempt=stale.get(attempt.cookieSettings().name);
        for(const options of [{noCsrf:true},{origin:'https://other.invalid'}]) {
            result=await request(stale,'POST','/api/registration/recover-session',{},options);assert.equal(result.status,403);assert.equal(result.set.length,0);
        }
        console.log('PASS expiry classification; recovery requires origin and real double-submit CSRF');
        result=await request(stale,'POST','/api/registration/recover-session');assert.equal(result.status,200);assert.equal(stale.get('qa_at'),'');assert.equal(stale.get('qa_rt'),'');assert.equal(stale.get(attempt.cookieSettings().name),originalAttempt);assert.equal(creates,0);
        assert.equal((await request(stale,'GET','/api/registration/context')).body.sessionState,'anonymous');
        result=await request(stale,'POST','/api/auth/register',input);assert.equal(result.status,201);assert.equal(creates,1);
        assert.equal(attempts[0].secret,attempt.readAttempt({cookies:{[attempt.cookieSettings().name]:originalAttempt}}).secret);
        console.log('PASS explicit recovery preserves attempt and creates nothing; later user submission succeeds');
        const oldForm=jar();await request(oldForm,'GET','/api/registration/context');
        result=await request(oldForm,'POST','/api/auth/register',input,{noCsrf:true});assert.equal(result.status,403);assert.equal(result.set.length,0);
        result=await request(oldForm,'POST','/api/auth/register',input);assert.equal(result.status,201);assert.equal(oldForm.get('qa_at'),'');assert.equal(oldForm.get('qa_rt'),'');assert.equal(creates,2);
        console.log('PASS previous frontend original submission recovers expiry without a replay; invalid CSRF cannot clear cookies');
        for(const token of ['malformed',access(false)]) {
            principalActive=false;const revoked=jar();revoked.set('qa_at',token);
            assert.equal((await request(revoked,'GET','/api/registration/context')).body.sessionState,'expired');
            assert.equal((await request(revoked,'POST','/api/registration/recover-session')).status,200);
        }
        principalActive=true;
        console.log('PASS malformed and revoked access can recover');
        const active=jar(false);result=await request(active,'GET','/api/registration/context');assert.equal(result.body.sessionState,'active');
        result=await request(active,'POST','/api/auth/register',input);assert.equal(result.body.code,'ACCOUNT_ALREADY_AUTHENTICATED');assert.equal(result.set.length,0);
        result=await request(active,'POST','/api/registration/recover-session');assert.equal(result.status,403);assert.equal(result.set.length,0);
        console.log('PASS valid access is neither discarded nor allowed to register');
        refreshActive=true;
        for(const hasAccess of [true,false]) {
            const renewable=jar();if(!hasAccess)renewable.delete('qa_at');
            result=await request(renewable,'GET','/api/registration/context');assert.equal(result.body.sessionState,'active');
            result=await request(renewable,'POST','/api/registration/recover-session');assert.equal(result.body.code,'ACCOUNT_ALREADY_AUTHENTICATED');assert.equal(result.set.length,0);
            result=await request(renewable,'POST','/api/auth/register',input);assert.equal(result.body.code,'ACCOUNT_ALREADY_AUTHENTICATED');assert.equal(result.set.length,0);
        }
        refreshActive=false;assert.equal(creates,2);
        console.log('PASS renewable sessions survive expired or missing access cookies');
        const changed=jar();await request(changed,'GET','/api/registration/context');changed.set('qa_at',access(false));
        result=await request(changed,'POST','/api/registration/recover-session');assert.equal(result.status,409);assert.equal(result.set.length,0);
        const outage=jar();await request(outage,'GET','/api/registration/context');failDatabase=true;
        result=await request(outage,'POST','/api/registration/recover-session');assert.equal(result.status,503);assert.equal(result.set.length,0);failDatabase=false;
        console.log('PASS changed session and database outage never clear credentials or create accounts');
    } finally {await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

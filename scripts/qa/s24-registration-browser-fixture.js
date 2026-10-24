'use strict';
// Test infrastructure only. Real SQL/auth/cookies, synthetic data, no SMTP or
// configured database writes. Browser assertions live in the frontend repo.
const fs=require('node:fs/promises'),path=require('node:path');
const {createHash}=require('node:crypto');
const {Sequelize}=require('sequelize');
async function start(options={}) {
    if(process.env.S24_QA_ISOLATED!=='1')throw Error('Isolated QA opt-in required');
    const resume=options.existingIsolatedDatabase;
    if(resume && (!/^s24b_qa_[a-f0-9]{32}$/.test(resume) || Number(process.env.S24_QA_PORT||33324)!==33324))throw Error('Only existing S24 local QA on 33324 may resume');
    const base=resume?{database:resume}:await require('./s24-provisioning-mysql').run({quiet:true});
    const db=new Sequelize(base.database,'root','',{host:'127.0.0.1',port:Number(process.env.S24_QA_PORT||33324),dialect:'mysql',logging:false,pool:{max:1,min:0,idle:1000}});
    if(!resume)for(const sql of require('../migrations/s24ContactSchema').statements)await db.query(sql);
    if(options.activation && !resume) {
        const schema=require('../migrations/s24ActivationSchema');
        for(const sql of schema.statements)await db.query(sql);
        await db.query(schema.backfill);
    }
    const policy=JSON.stringify({version:'qa-only-r3',source:'Synthetic QA only',license:'Original fixtures',passwords:['a common password for tests']});
    const policyPath=path.resolve(__dirname,'../../../_qa/s24-r3/password-policy.json');await fs.writeFile(policyPath,policy);
    Object.assign(process.env,{REGISTRATION_ENABLED:'true',REGISTRATION_IDENTITY_ENABLED:'true',REGISTRATION_HMAC_KEY:'29'.repeat(32),
        REGISTRATION_ACTIVATION_ENABLED:options.activation?'true':'false',
        REGISTRATION_PASSWORD_BLOCKLIST_PATH:policyPath,REGISTRATION_PASSWORD_BLOCKLIST_SHA256:createHash('sha256').update(policy).digest('hex'),
        AUTH_COOKIE_MODE:'d2',BROWSER_AUTH_TRANSPORT:'cookie',AUTH_COOKIE_SECURE:'false',AUTH_COOKIE_DOMAIN:'',AUTH_COOKIE_PATH:'/',
        AUTH_COOKIE_ACCESS_NAME:'s24_qa_at',AUTH_COOKIE_REFRESH_NAME:'s24_qa_rt',AUTH_CSRF_COOKIE_NAME:'s24_qa_csrf',CSRF_COOKIE_NAME:'s24_qa_csrf',
        AUTH_COOKIE_SAMESITE:'lax',CSRF_ENABLED:'true',CSRF_ORIGIN_CHECK_ENABLED:'true',CORS_CREDENTIALS:'true',NODE_ENV:'test',APP_ENV:'test',
        CORS_ALLOWED_ORIGINS:'http://127.0.0.1:4338',CSRF_ALLOWED_ORIGINS:'http://127.0.0.1:4338'});
    const shared=require('../../src/db/Sequelize.connection');
    shared.query=(...args)=>db.query(...args);shared.transaction=(...args)=>db.transaction(...args);
    if(options.prepare && !resume)await options.prepare(db);
    const security=require('../../src/config/security'),jwt=require('../../src/config/jwt');
    security.getCsrfTokenSecret=()=> 'synthetic-csrf-r3';security.getRefreshTokenSecret=()=> 'synthetic-refresh-r3';
    jwt.key='synthetic-jwt-r3';jwt.expiresIn={expiresIn:'15m'};
    const deliveries=[];const controls={sessionFails:false,deliveryFails:false};
    const {ContactDelivery}=require('../../src/services/registration/contactDelivery');
    const delivery=new ContactDelivery({email:{ready:()=>true,send:async message=>{if(controls.deliveryFails)return false;deliveries.push(message);return true;}}});
    const express=require('express'),app=express();
    // Exercise the same preflight as the normal server; a hand-written header
    // list hid the missing Idempotency-Key in the original registration QA.
    app.use(require('../../src/middleware/corsCredentialed.middleware').corsCredentialedAllowlist());
    app.use(require('cookie-parser')());app.use(require('../../src/middleware/requestBody.middleware').defaultBodyParser);
    app.use('/api',require('../../src/routes/mysql/registration').createRouter({database:db,delivery,preparation:options.preparation,
        login:(...args)=>controls.sessionFails?{status:503}:require('../../src/Dao/mysql/auth.dao').login(...args)}));
    app.use('/api/auth',require('../../src/routes/mysql/auth'));
    // The unchanged login requests these public brand/theme endpoints. No clinical API is stubbed.
    if(!options.realConfiguration) {
        app.get('/api/config/login-image/get',(req,res)=>res.json({success:true,data:null}));
        app.get('/api/config/theme/get',(req,res)=>res.json({success:true,data:{code:'medical-blue',primary_700:'#1497BD'}}));
    }
    if(options.extendApp)options.extendApp(app);
    app.use((req,res)=>res.status(404).json({success:false,message:'QA route unavailable'}));
    app.use((error,req,res,next)=>res.status(500).json({code:'QA_UNEXPECTED_ERROR'}));
    const server=await new Promise(resolve=>{const instance=app.listen(options.port||4337,'127.0.0.1',()=>resolve(instance));});
    return {db,deliveries,controls,database:base.database,close:async()=>{await new Promise(resolve=>server.close(resolve));await db.close();}};
}
if(require.main===module)start().then(async fixture=>{
    try {
        await require('../../../hemia-assistance-front-legacy/scripts/qa/s24-registration-browser.cjs').run(fixture);
    } finally {await fixture.close();}
}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={start};

'use strict';
// Dedicated synthetic database only; real HTTP, cookies, CSRF, ownership and SQL.
// Activation is a test fixture write, never a product HTTP endpoint.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path');
async function run() {
    let preparationCalls=0,readiness={success:true,data:{steps:[{id:'profile',ready:false}],pending:1,completed:0}};
    const port=Number(process.env.S24_QA_HTTP_PORT||4337);
    const fixture=await require('./s24-registration-browser-fixture').start({port,activation:true,preparation:async()=>{preparationCalls++;return readiness;}});
    const checks=[],base='http://127.0.0.1:'+port,origin='http://127.0.0.1:4338';
    const api=require('../../../docs/saas-platform/registration/registration.openapi.json');
    const Ajv=require('../../../hemia-assistance-front-legacy/node_modules/ajv');
    const definitions=JSON.parse(JSON.stringify(api.components.schemas).replaceAll('#/components/schemas/','#/definitions/'));
    const ajv=new Ajv({allErrors:true,nullable:true,unknownFormats:'ignore'});
    const contracts=Object.fromEntries(['Activation','Plans','Acknowledged','Registered'].map(name=>[name,ajv.compile({definitions,$ref:'#/definitions/'+name})]));
    async function request(jar,method,url,body,headers={}) {
        const response=await fetch(base+url,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...headers},body:body===undefined?undefined:JSON.stringify(body)});
        for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],index=pair.indexOf('=');jar.set(pair.slice(0,index),pair.slice(index+1));}
        const result={status:response.status,body:await response.json()};
        const contract={'/api/account/activation':'Activation','/api/account/activation/plans':'Plans','/api/account/setup-welcome/acknowledge':'Acknowledged','/api/auth/register':'Registered'}[url];
        if(response.ok && contract)assert.equal(contracts[contract](result.body),true,JSON.stringify(contracts[contract].errors));
        return result;
    }
    async function csrf(jar) {const response=await request(jar,'GET','/api/auth/csrf');return {'X-CSRF-Token':response.body.data.csrfToken};}
    const q=(sql,replacements={})=>fixture.db.query(sql,{replacements,type:/^SELECT/i.test(sql)?require('sequelize').QueryTypes.SELECT:require('sequelize').QueryTypes.RAW});
    try {
        const jar=new Map();const context=await request(jar,'GET','/api/registration/context');assert.equal(context.body.enabled,true);
        const input={account:{name:'QA R4 Administrator',telephone:'5590004321',email:'r4@example.invalid',password:'Synthetic R4 unique phrase only!'},business:{name:'QA R4 Clinic'},
            legalContext:context.body.legalContext,
            legalAcceptances:context.body.legalDocuments.map(d=>({documentKey:d.documentKey,versionId:d.versionId,acknowledged:true}))};
        let response=await request(jar,'POST','/api/auth/register',input,{...await csrf(jar),'Idempotency-Key':randomUUID()});
        assert.equal(response.status,201);const actor=response.body.activation;
        const ids={login:actor.accountId,business:actor.businessId};
        assert.equal((await q('SELECT * FROM registration_account WHERE id_login=:login',ids)).length,1);
        assert.equal((await request(jar,'GET','/api/auth/session')).body.data.business.registrationWelcomePending,true);
        assert.equal((await request(jar,'GET','/api/auth/session')).body.data.business.registrationActivationConfirmed,false);
        response=await request(jar,'GET','/api/account/activation');assert.equal(response.body.nextAction,'verify_contacts');assert.equal(preparationCalls,0);
        assert.equal((await request(jar,'POST','/api/account/setup-welcome/acknowledge',{acknowledged:true},await csrf(jar))).status,403);
        assert.equal((await request(jar,'POST','/api/account/activation/checkout',{},await csrf(jar))).status,409);
        checks.push('Atomic registration continuity, D2 marker, pending contact gate and no readiness reads before activation');
        response=await request(jar,'POST','/api/account/contact-verifications',{channel:'email'},await csrf(jar));assert.equal(response.status,202);
        response=await request(jar,'POST','/api/account/contact-verifications/confirm',{challengeId:response.body.challengeId,code:fixture.deliveries.at(-1).code},await csrf(jar));assert.equal(response.status,200);
        const plans=await request(jar,'GET','/api/account/activation/plans');assert.deepEqual(plans.body,{available:false,offers:[],reason:'provider_unavailable',planId:'professional'});
        response=await request(jar,'POST','/api/account/activation/checkout',{planId:'professional',paid:true},await csrf(jar));assert.equal(response.status,503);assert.equal(response.body.code,'BILLING_UNAVAILABLE');
        assert.equal((await request(jar,'GET','/api/account/activation?paid=true')).status,400);
        assert.equal((await request(new Map(),'GET','/api/account/activation')).status,401);
        assert.equal((await request(jar,'GET','/api/account/activation')).body.subscriptionStatus,'pending_activation');assert.equal(preparationCalls,0);
        checks.push('Only Professional, unavailable catalog/checkout, no client activation, no anonymous access');
        // Synthetic server-authoritative projection; R5 must provide the real writer.
        await q("UPDATE business SET subscription_status='active',plan='professional' WHERE id_business=:business",ids);
        assert.equal((await request(jar,'GET','/api/account/activation')).body.nextAction,'wait_confirmation');
        await q('UPDATE registration_account SET activation_completed_at=NOW(3) WHERE id_login=:login',ids);
        response=await request(jar,'GET','/api/account/activation');assert.equal(response.body.destination,'summary');assert.equal(response.body.nextAction,'setup_summary');assert.equal(response.body.commercialState,'activated');
        assert.equal((await request(jar,'GET','/api/auth/session')).body.data.business.registrationActivationConfirmed,true);
        assert.equal((await request(jar,'GET','/api/account/activation')).body.welcomePending,true);
        assert.equal((await q('SELECT setup_welcome_acknowledged_at FROM registration_account WHERE id_login=:login',ids))[0].setup_welcome_acknowledged_at,null);
        checks.push('Active status alone insufficient, confirmed projection resolves Summary; reads/reloads never consume welcome');
        readiness={success:false};assert.equal((await request(jar,'GET','/api/account/activation')).body.nextAction,'retry_preparation');
        readiness={success:true,data:{steps:[]}};assert.equal((await request(jar,'GET','/api/account/activation')).body.nextAction,'retry_preparation');
        readiness={success:true,data:{steps:[{ready:true}]}};assert.equal((await request(jar,'GET','/api/account/activation')).body.destination,'home');
        readiness={success:true,data:{steps:[{ready:false}]}};
        readiness={status:200,data:{steps:[{ready:false}]}};
        assert.equal((await request(jar,'GET','/api/account/activation')).body.destination,'summary','Internal preparation DAO returns status, not success');
        readiness={status:200,success:false,data:{steps:[{ready:true}]}};
        assert.equal((await request(jar,'GET','/api/account/activation')).body.nextAction,'retry_preparation','Explicit failure must not be accepted');
        readiness={status:503,data:{steps:[{ready:true}]}};
        assert.equal((await request(jar,'GET','/api/account/activation')).body.nextAction,'retry_preparation');
        readiness={status:200,data:{steps:[{ready:false}]}};
        checks.push('Failed/empty preparation remains recoverable; genuinely complete preparation resolves Home');
        assert.equal((await request(jar,'POST','/api/account/setup-welcome/acknowledge',{acknowledged:true})).status,403);
        assert.equal((await request(jar,'POST','/api/account/setup-welcome/acknowledge',{acknowledged:true,id_business:'foreign'},await csrf(jar))).status,400);
        assert.equal((await request(jar,'GET','/api/account/activation?id_business=foreign')).status,400);
        const acknowledgements=await Promise.all([1,2].map(async()=>request(jar,'POST','/api/account/setup-welcome/acknowledge',{acknowledged:true},await csrf(jar))));
        acknowledgements.forEach(r=>assert.equal(r.status,200));assert.equal(acknowledgements[0].body.acknowledgedAt,acknowledgements[1].body.acknowledgedAt);
        const calls=preparationCalls;assert.equal((await request(jar,'GET','/api/account/activation')).body.destination,'home');assert.equal(preparationCalls,calls);
        assert.equal((await request(jar,'GET','/api/auth/session')).body.data.business.registrationWelcomePending,false);
        checks.push('CSRF, field/tenant injection rejection, concurrent idempotent acknowledgement, refreshed session and later Home without readiness dependency');
        await q("UPDATE business SET subscription_status='past_due' WHERE id_business=:business",ids);
        response=await request(jar,'GET','/api/account/activation');assert.equal(response.body.destination,'restricted');
        assert.equal((await request(jar,'POST','/api/account/setup-welcome/acknowledge',{acknowledged:true},await csrf(jar))).status,409);
        await q("UPDATE business SET subscription_status='active' WHERE id_business=:business",ids);
        assert.equal((await request(jar,'GET','/api/account/activation')).body.welcomePending,false);
        // Durable backfill is repeatable and must not erase acknowledged state.
        await q(require('../migrations/s24ActivationSchema').backfill);
        assert.equal((await request(jar,'GET','/api/account/activation')).body.welcomePending,false);
        const {AccountActivationService}=require('../../src/services/registration/accountActivation.service');
        await assert.rejects(new AccountActivationService(fixture.db).account({id_login:ids.login,id_business:'foreign'}),e=>e.code==='ACTIVATION_FORBIDDEN');
        checks.push('Restriction precedence, renewal/backfill preserve continuity, service enforces actor + tenant');
        const output={result:'PASS',database:fixture.database,checks,scope:'Real HTTP/MySQL/auth; captured email, synthetic activation projection and readiness adapter. No billing provider.'};
        const folder=path.resolve(__dirname,'../../../docs/saas-platform/phases/evidence/S24_R4');await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'http-mysql.json'),JSON.stringify(output,null,2));
        console.log(JSON.stringify(output,null,2));
    } finally {await fixture.close();}
}
if(require.main===module)run().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={run};

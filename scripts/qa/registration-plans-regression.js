'use strict';
const assert=require('node:assert/strict');
const {Sequelize}=require('sequelize');
const express=require('express');
const {PaymentsService}=require('../../src/services/payments/payments.service');
const databasePath=require.resolve('../../src/db/Sequelize.connection');
require.cache[databasePath]={id:databasePath,filename:databasePath,loaded:true,exports:new Sequelize('synthetic_plans','root','',{dialect:'mysql',host:'127.0.0.1',port:33324,logging:false})};
const sample=()=>[{productCode:'medsync',code:'medsync_pro',name:'Profesional',description:null,status:'active',versions:[{version:1,status:'published',effectiveFrom:null,effectiveUntil:null,prices:[{code:'medsync_pro_monthly_mxn',amount:'999.00',currency:'MXN',billingInterval:'month',billingIntervalCount:1,status:'active'}],entitlements:[{feature:{code:'users.auxiliary.included',name:'Usuarios',unit:null},valueJson:{value:3}}]}]}];
const env={NODE_ENV:'test',HEMIA_CLIENT_ID:'qa-medsync',HEMIA_CLIENT_SECRET:'synthetic-only',PAYMENTS_CONNECTION:JSON.stringify({issuer:'https://identity.test',tokenUrl:'https://identity.test/oauth/token',clientId:'qa-medsync',baseUrl:'https://billing.test/api/v1',audience:'billing-api',productCode:'medsync'})};
async function run() {
 const originalFetch=global.fetch;let server,calls=0,data=sample(),outage=false;
 const fresh=()=>new PaymentsService({}, {env});let adapter=fresh();
 const paymentsPath=require.resolve('../../src/services/payments/payments.service');
 require.cache[paymentsPath].exports={...require.cache[paymentsPath].exports,configuredPayments:()=>adapter};
 try {
  global.fetch=async(url,options)=>{
   url=new URL(url);
   if(url.hostname==='identity.test')return new Response(JSON.stringify({access_token:'synthetic-access',token_type:'Bearer',expires_in:300,scope:new URLSearchParams(options.body).get('scope')}),{headers:{'content-type':'application/json'}});
   if(url.hostname==='billing.test') {
    assert.equal(options.redirect,'error');
    if(url.pathname==='/api/v1/billing/integrations/v1/compatibility')return new Response(JSON.stringify({contract:'billing.integrations.v1',billingVersion:'1.4.1'}),{headers:{'content-type':'application/json'}});
    assert.equal(url.pathname,'/api/v1/billing/integrations/v1/catalog/products/medsync/plans');calls++;
    if(outage)throw Error('synthetic timeout');
    return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
   }
   return originalFetch(url,options);
  };
  let responses=await Promise.all([adapter.plans(),adapter.plans()]);assert.equal(calls,1);assert.equal(responses[0].available,true);assert.equal(responses[0].offers[0].prices[0].amount,'999.00');assert.equal(responses[0].taxBehavior,'inclusive');assert.equal(responses[0].checkoutAvailable,false);assert.equal(responses[0].trialDays,15);await adapter.plans();assert.equal(calls,1);
  for(const invalid of [[{...sample()[0],productCode:'other'}],[],[{...sample()[0],versions:[{...sample()[0].versions[0],prices:[{...sample()[0].versions[0].prices[0],amount:999}]}]}]]){data=invalid;adapter=fresh();assert.equal((await adapter.plans()).available,false);}
  outage=true;adapter=fresh();assert.deepEqual((await adapter.plans()).offers,[]);
  process.env.REGISTRATION_ENABLED='false';const {createRouter}=require('../../src/routes/mysql/registration');const app=express();app.use('/api',createRouter({database:{},registration:{},delivery:{ready:()=>false}}));
  server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});const base='http://127.0.0.1:'+server.address().port;
  let response=await originalFetch(base+'/api/registration/plans');assert.equal(response.status,200);assert.equal((await response.json()).available,false);
  outage=false;data=sample();adapter=fresh();response=await originalFetch(base+'/api/registration/plans');assert.equal(response.status,200);const body=await response.json();assert.equal(body.available,true);assert.equal(body.taxBehavior,'inclusive');
  response=await originalFetch(base+'/api/registration/plans?product_code=other');assert.equal(response.status,400);
        // Exercise the real session presentation with synthetic DAO output.
        const dao=require('../../src/Dao/mysql/auth.dao');
        const controller=require('../../src/controller/mysql/auth.controller');
        const jwt=require('jsonwebtoken');
        const claims={id_login:'qa',id_session:'session',id_business:'business',rol:'admin'};
        dao.session=async()=>({status:200,success:true,data:{token:jwt.sign(claims,'synthetic-qa-only'),permisos:[],business:{id_business:'business',subscription_status:'trial',trial_ends_at:new Date(Date.now()+15*86400000).toISOString(),plan:'pro'},tenantOperational:{allowed:true}}});
        let payload;
        const res={status(code){assert.equal(code,200);return this;},send(value){payload=value;},clearCookie(){}};
        await controller.session({tokenDecode:claims,headers:{},get:()=>'',method:'GET',originalUrl:'/api/auth/session'},res,()=>{});
        assert.equal(payload.data.business.trialDaysRemaining,15);
        assert.ok(payload.data.business.trialEndsAt);assert.ok(payload.data.business.serverNow);
        assert.equal(payload.data.user.id_session,undefined,'Session identifiers remain private in this response');
  console.log('PASS SDK public catalog: fixed product, decimal money, IVA included, concurrent/cache reads, invalid/outage fallback; HTTP independent of registration/DB/email; server-derived trial days.');
 }finally{global.fetch=originalFetch;if(server)await new Promise(resolve=>server.close(resolve));}
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

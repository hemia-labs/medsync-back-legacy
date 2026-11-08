'use strict';
const assert=require('node:assert/strict');
const axios=require('axios');
const {Sequelize}=require('sequelize');
const express=require('express');
const catalogPath=require.resolve('../../src/services/registration/commercialAdapter');
const databasePath=require.resolve('../../src/db/Sequelize.connection');
// No configured database or provider is used by this regression.
require.cache[databasePath]={id:databasePath,filename:databasePath,loaded:true,exports:new Sequelize('synthetic_plans','root','',{dialect:'mysql',host:'127.0.0.1',port:33324,logging:false})};
const sample=()=>({productCode:'medsync',plans:[{code:'medsync_pro',name:'Profesional',prices:[{code:'medsync_pro_monthly_mxn',amount:'999.00',currency:'MXN',billingInterval:'month',billingIntervalCount:1}],features:{'professionals.included':1,'users.auxiliary.included':3,'schedule.advanced':true}}]});
const fresh=()=>{delete require.cache[catalogPath];return require(catalogPath);};
async function run() {
    const originalGet=axios.get;
    let calls=0,server;
    try {
        axios.get=async(url,options)=>{
            calls++;assert.equal(url,'https://billing.hemia.cloud/api/v1/billing/catalog/plans');
            assert.deepEqual(options.params,{product_code:'medsync'});assert.equal(options.maxRedirects,0);assert.ok(options.timeout<=5000);
            return {data:sample()};
        };
        let adapter=fresh();
        const responses=await Promise.all([adapter.plans(),adapter.plans()]);
        assert.equal(calls,1);assert.equal(responses[0].offers[0].prices[0].amount,'999.00');
        assert.equal(responses[0].taxBehavior,'inclusive');assert.equal(responses[0].checkoutAvailable,false);assert.equal(responses[0].trialDays,15);
        await adapter.plans();assert.equal(calls,1);
        await assert.rejects(adapter.checkout(),e=>e.code==='BILLING_UNAVAILABLE');
        for(const invalid of [
            {productCode:'other',plans:sample().plans},
            {...sample(),plans:[]},
            {...sample(),plans:[...sample().plans,...sample().plans]},
            {...sample(),plans:[{...sample().plans[0],prices:[{...sample().plans[0].prices[0],amount:999}]}]},
            {...sample(),plans:[{...sample().plans[0],features:{'professionals.included':'<script>'}}]}
        ]) {
            axios.get=async()=>({data:invalid});adapter=fresh();
            assert.equal((await adapter.plans()).available,false);
        }
        axios.get=async()=>{throw Error('synthetic timeout');};adapter=fresh();
        assert.deepEqual((await adapter.plans()).offers,[]);
        // A catalog outage neither blocks registration readiness nor reveals error details.
        process.env.REGISTRATION_ENABLED='false';
        const {createRouter}=require('../../src/routes/mysql/registration');
        const app=express();app.use('/api',createRouter({database:{},registration:{},delivery:{ready:()=>false}}));
        server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
        const base='http://127.0.0.1:'+server.address().port;
        let response=await fetch(base+'/api/registration/plans');assert.equal(response.status,200);
        assert.equal((await response.json()).available,false);
        axios.get=async()=>({data:sample()});fresh();
        response=await fetch(base+'/api/registration/plans');assert.equal(response.status,200);
        const body=await response.json();assert.equal(body.available,true);assert.equal(body.taxBehavior,'inclusive');
        response=await fetch(base+'/api/registration/plans?product_code=other');assert.equal(response.status,400);
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
        console.log('PASS public catalog: fixed product, decimal money, IVA included, concurrent/cache reads, invalid/outage fallback, checkout disabled; real HTTP without registration/DB/email readiness; server-derived trial days in session.');
    } finally {axios.get=originalGet;if(server)await new Promise(resolve=>server.close(resolve));}
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

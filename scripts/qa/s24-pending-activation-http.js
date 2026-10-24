'use strict';
// Real HTTP/JWT middleware; persistence is a deliberately small explicit double.
// SQL ownership/concurrency is covered independently by s24-identity-mysql.js.
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const root = path.resolve(__dirname, '../..');
const stub = (file, exports) => { require.cache[require.resolve(path.join(root,file))] = { exports }; };
const key = 's24-synthetic-http-fixture-key';
let status = 'pending_activation', reservation = true, cookieMode = true, businessActive = 1;
stub('src/db/Sequelize.connection.js', { query: async sql => {
    if(sql.includes('FROM auth_identity')) return reservation ? [{id_login:'fixture-login'}] : [];
    return [{id_login:'fixture-login', id_session:'fixture-session',id_business:'fixture-business',rol:'admin',subscription_status:status}];
}});
stub('src/config/jwt.js', {key,expiresIn:{expiresIn:'10m'}});
stub('src/config/authCookie.config.js', {
    getAuthCookieConfig:()=>({isCookieAuthEnabled:cookieMode}), assertAuthCookieConfig:()=>({}),
    getCookieNames:()=>({access:'qa_access',refresh:'qa_refresh'})
});
stub('src/services/security/securityLogger.service.js',{record:()=>{}});
stub('src/Dao/mysql/tenantOperational.dao.js',{getBusiness:async()=>({active:businessActive,subscription_status:status})});
const Token = require('../../src/auth/authenticate');
const { routes } = require('../../src/auth/pendingActivation');
const requireOperational = require('../../src/middleware/requireTenantOperational.middleware');
const {isBusinessOperational} = require('../../src/util/businessOperational');
const app = express();
app.use(cookieParser());
app.get('/api/auth/session',Token.OptionalAuth,(req,res)=>res.json({authenticated:Boolean(req.tokenDecode)}));
app.get('/api/optional-clinical',Token.OptionalAuth,(req,res)=>res.json({reached:true}));
app.use('/api',Token.Auth);
app.use((req,res)=>res.json({reached:true,status:req.tokenDecode.subscription_status}));

async function run() {
    const server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const token = jwt.sign({id_login:'fixture-login',id_session:'fixture-session',id_business:'fixture-business',subscription_status:'active'},key);
    const base='http://127.0.0.1:'+server.address().port;
    let checks=0;
    try {
        for(const cookies of [true,false]) {
            cookieMode=cookies; status='pending_activation';reservation=true;
            const request=async(method,url)=>fetch(base+url,{method,headers:cookies?{Cookie:'qa_access='+token}:{Authorization:'Bearer '+token}});
            for(const route of routes){const [method,url]=route.split(' ');assert.equal((await request(method,url+'?untrusted=active')).status,200,route);checks++;}
            for(const [method,url] of [['GET','/api/px/get/fixture'],['POST','/api/px/search'],['GET','/api/business/preparation'],
                ['GET','/api/config/timezone/get'],['GET','/api/user/list'],['GET','/api/account/activation/other'],
                ['DELETE','/api/account/activation'],['PUT','/api/business/current'],['GET','/api/optional-clinical']]) {
                const response=await request(method,url);assert.equal(response.status,403);
                assert.equal((await response.json()).reasonCode,'ACCOUNT_PENDING_ACTIVATION');checks++;
            }
            reservation=false;
            assert.equal((await request('GET','/api/account/activation')).status,401);checks++;
            reservation=true;status=' PENDING_ACTIVATION ';
            assert.equal((await request('GET','/api/business/preparation')).status,403);checks++;
            reservation=true;status='active';
            assert.equal((await request('GET','/api/business/preparation')).status,200);checks++;
            status='past_due';
            assert.equal((await request('GET','/api/px/get/fixture')).status,200,'Normal tenant restrictions remain in their own middleware');checks++;
        }
        for(const entry of requireOperational.MINIMAL_READ_ROUTES) {
            // Every legacy exception is denied independently of Auth when pending.
            status='pending_activation';
            let continued=false, denied;
            const res={status:code=>{denied=code;return res;},send:()=>{}};
            await requireOperational({tokenDecode:{id_business:'fixture-business',rol:'admin'},method:entry.method,baseUrl:entry.baseUrl,path:'/get/fixture'},res,()=>{continued=true;});
            assert.equal(continued,false);assert.equal(denied,403);checks++;
        }
        assert.equal(isBusinessOperational({active:1,subscription_status:'pending_activation'}).reasonCode,'ACCOUNT_PENDING_ACTIVATION');checks++;
        status='pending_activation';businessActive=0;let inactiveDenied;
        const inactiveRes={status:code=>{inactiveDenied=code;return inactiveRes;},send:()=>{}};
        await requireOperational({tokenDecode:{id_business:'fixture-business',rol:'admin'},method:'GET',baseUrl:'/api/px',path:'/get/fixture'},inactiveRes,()=>assert.fail('Inactive pending account cannot use legacy read exceptions'));
        assert.equal(inactiveDenied,403);checks++;businessActive=1;
        // Verify the actual existing read exception, not merely its route metadata.
        status='past_due';let continued=false;
        await requireOperational({tokenDecode:{id_business:'fixture-business',rol:'admin'},method:'GET',baseUrl:'/api/px',path:'/get/fixture'}, {},()=>{continued=true;});
        assert.equal(continued,true);checks++;
        console.log(JSON.stringify({result:'PASS',checks,persistence:'explicit double',http:'real loopback, JWT/cookie + bearer, actual Auth and operational guards'}));
    } finally { await new Promise(resolve=>server.close(resolve)); }
}
run().catch(error=>{console.error(error);process.exitCode=1;});

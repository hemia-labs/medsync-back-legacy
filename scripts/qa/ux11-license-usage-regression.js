'use strict';
// Exercise the real route permission middleware and controller with local stubs.
// No HTTP server, database, authentication credentials or mutations are used.
const assert = require('node:assert/strict');
function stub(modulePath, exports) {
    const id = require.resolve(modulePath);
    require.cache[id] = {id, filename:id, loaded:true, exports};
}
let permitted = true, licenseCalls = 0, permissionCalls = 0, lastBusiness;
let scenario = 'finite';
const usage = (used, limit) => ({used, limit, remaining:limit === null ? null : Math.max(limit-used,0), exceeded:limit === null ? false : used>limit});
const knownLicense = () => ({
    business:{plan:'pro',id_business:'tenant-token',billing_email:'private-billing@example.test'},
    plan:{name:'Profesional',monthlyPriceMxn:799,currency:'MXN'},
    usage:{patients:100},overrides:{private_reason:'private override'},
    limits:{professionals:usage(1,1),staffUsers:usage(1,3),branches:usage(1,1)}
});
stub('../../src/Dao/mysql/business.dao', {});
stub('../../src/Dao/mysql/preparation.dao', {});
stub('../../src/util/effectivePermissions', {isTenantAdministrator:async () => false});
stub('../../src/util/licenseLimits', {async getBusinessEffectiveLicense(business) {
    licenseCalls++; lastBusiness=business;
    assert.equal(business, 'tenant-token', 'Only the authenticated tenant reaches the license query');
    if(scenario === 'throw') throw Error('SQL rejected password=secret server/private-billing@example.test');
    if(scenario === 'missing') return null;
    const license = knownLicense();
    if(scenario === 'unlimited') license.limits.staffUsers = usage(2,null);
    if(scenario === 'unknown') {license.business.plan='unknown-obsolete';license.plan.name='Unknown';license.limits.professionals=usage(1,null);license.limits.staffUsers=usage(2,null);}
    return license;
} });
stub('../../src/Dao/mysql/user.dao', {async hasPermission(actor, code) {
    permissionCalls++;
    assert.equal(actor, 'actor-token'); assert.equal(code, 'admin.users');
    return permitted;
} });
stub('../../src/services/security/securityLogger.service', {record() {}});
stub('../../src/auth/authenticate', {Auth(req,res,next) {
    if(!req.tokenDecode || !req.tokenDecode.id_login) {res.status(401).send({status:401,message:'Token invalido o no enviado.'});return;}
    next();
} });
stub('../../src/middleware/requireTenantOperational.middleware', (req,res,next) => next());
stub('../../src/middleware/csrf.middleware', {csrfProtection:() => (req,res,next) => next()});
stub('../../src/middleware/awaitHandlerFactory.middleware', handler => handler);
const router = require('../../src/routes/mysql/business');
const route = router.stack.find(layer => layer.route && layer.route.path === '/license-usage').route;
assert.deepEqual(Object.keys(route.methods), ['get']);
async function request(token = {id_business:'tenant-token',id_login:'actor-token'}) {
    const req = {tokenDecode:token,body:{id_business:'tenant-injected',id_login:'actor-injected'},query:{id_business:'tenant-injected'},params:{id_business:'tenant-injected'}};
    const result = {headers:{}, status:0, body:null};
    const res = {set(key,value) {result.headers[key]=value;return this;}, status(status) {result.status=status;return this;}, send(body) {result.body=body;return this;}};
    async function run(index) {
        if(index >= route.stack.length) return;
        let nextResult;
        await route.stack[index].handle(req,res,error => {if(error)throw error; nextResult=run(index+1);});
        if(nextResult) await nextResult;
    }
    await run(0);
    return result;
}
(async () => {
    permitted=false;
    let result = await request();
    assert.equal(result.status,403);
    assert.equal(licenseCalls,0,'Denied permission must not consult license');
    assert.equal(permissionCalls,1);
    result = await request(null);
    assert.equal(result.status,401);
    assert.equal(permissionCalls,1,'No actor must not consult permissions or license');
    assert.equal(licenseCalls,0);
    permitted=true;
    result = await request();
    assert.equal(result.status,200);
    assert.equal(lastBusiness,'tenant-token');
    assert.equal(result.headers['Cache-Control'],'no-store');
    assert.deepEqual(result.body.data,{business:{planName:'Profesional'},license:{professionals:usage(1,1),staffUsers:usage(1,3)}});
    assert.doesNotMatch(JSON.stringify(result.body),/billing|799|MXN|override|patients|tenant-token|id_login|signature|professional_license|password|secret/,'Payload exposes only plan display name and resource counts');
    scenario='unlimited'; result=await request();
    assert.equal(result.status,200);
    assert.equal(result.body.data.license.staffUsers.limit,null,'Known plans may explicitly declare an unlimited resource');
    scenario='unknown'; result=await request();
    assert.equal(result.status,500);
    assert.equal(result.body.data,null,'Unknown plan never becomes a success response with unlimited counts');
    assert.match(result.body.message,/plan.*revisión/);
    assert.equal(result.headers['Cache-Control'],'no-store');
    scenario='missing'; result=await request();
    assert.equal(result.status,404);
    assert.equal(result.body.data,null);
    assert.equal(result.headers['Cache-Control'],'no-store');
    scenario='throw'; result=await request();
    assert.equal(result.status,500);
    assert.equal(result.headers['Cache-Control'],'no-store');
    assert.doesNotMatch(JSON.stringify(result.body),/SQL|password|secret|private-billing|server\//);
    console.log('PASS license usage: admin.users guard runs before license lookup; authenticated tenant overrides body/query/params; minimal payload; known unlimited vs unknown plan; missing/sanitized failures and no-store.');
})().catch(error => {console.error(error);process.exitCode=1;});

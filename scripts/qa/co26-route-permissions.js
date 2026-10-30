'use strict';
const assert=require('node:assert/strict');
const stub=(name,exports)=>{const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports};};
let permissions=new Set(['px.tab.odontogram']),operational=true,calls=0;
stub('../../src/auth/authenticate',{Auth(req,res,next){if(!req.headers.auth)return res.status(401).send({});req.tokenDecode={id_login:'actor',id_business:'tenant'};next();}});
stub('../../src/middleware/requireTenantOperational.middleware',(req,res,next)=>operational?next():res.status(403).send({}));
stub('../../src/middleware/csrf.middleware',{csrfProtection:()=> (req,res,next)=>req.headers.csrf?next():res.status(403).send({})});
stub('../../src/Dao/mysql/user.dao',{hasPermission:async(actor,permission)=>permissions.has(permission)});
stub('../../src/util/effectivePermissions',{hasPermission:async(actor,permission,options)=>{assert.equal(options.enabledCatalog,true);return permissions.has(permission);}});
stub('../../src/services/security/securityLogger.service',{record(){}});
const call=async(business,actor,id)=>{assert.equal(business,'tenant');calls++;if(id==='foreign')throw Object.assign(Error('Unavailable'),{status:404});return {};};
stub('../../src/Dao/mysql/odontogramV2.dao',{
 mode:async()=> 'v2',read:async(business,id)=>call(business,'actor',id),list:async(business,id)=>call(business,'actor',id),
 create:call,operations:call,lifecycle:call
});
const router=require('../../src/routes/mysql/odontogramV2');
function request(method,url,body={},headers={auth:true,csrf:true}){
 return new Promise((resolve,reject)=>{
  const req={method,url,originalUrl:url,headers,body,query:{},params:{}};
  const res={statusCode:200,status(value){this.statusCode=value;return this;},send(data){resolve({status:this.statusCode,data});}};
  router.handle(req,res,error=>error?reject(error):resolve({status:404}));
 });
}
(async()=>{
 assert.equal((await request('GET','/chart/chart',{},{})).status,401);assert.equal(calls,0);
 assert.equal((await request('GET','/chart/chart')).status,200);
 assert.equal((await request('POST','/chart/chart/ops')).status,403);
 permissions.add('odontogram.capture');
 assert.equal((await request('POST','/chart/chart/ops',{}, {auth:true})).status,403);
 assert.equal((await request('POST','/chart/chart/ops')).status,200);
 assert.equal((await request('POST','/chart/chart/finalize')).status,403);
 assert.equal((await request('POST','/charts/patient',{replace_active_id:'active'})).status,403);
 permissions.add('odontogram.finalize');
 assert.equal((await request('POST','/charts/patient',{replace_active_id:'active'})).status,200);
 assert.equal((await request('POST','/chart/chart/finalize')).status,200);
 assert.equal((await request('GET','/chart/foreign')).status,404);
 operational=false;assert.equal((await request('GET','/chart/chart')).status,403);operational=true;
 const before=calls;permissions.delete('odontogram.capture');assert.equal((await request('POST','/chart/chart/ops')).status,403);assert.equal(calls,before);
 console.log('PASS actual CO26 router: authentication, CSRF, tenant operational gate, independent capture/finalize, replacement permission and revocation. In-process only, no network/DB.');
})().catch(error=>{console.error(error);process.exitCode=1;});

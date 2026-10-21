'use strict';
const assert=require('node:assert/strict');
let plan='basic',profile='doctor',grants=['dashboard.scope.all','dashboard.operations','dashboard.clinical'];
const stub=(file,exports)=>{const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};};
stub('../../src/db/Sequelize.connection',{query:async(sql,options)=>{assert.ok(sql.includes('b.plan AS plan_code'));assert.equal(options.replacements.business,'tenant');return[{id_login:'actor',id_doctor_professional_profile:profile,professional_name:'Synthetic',plan_code:plan}];}});
stub('../../src/util/effectivePermissions',{rows:async()=>grants.map(code=>({code,is_active:1}))});
const {resolveDashboardAccess}=require('../../src/util/dashboardAccess');
stub('../../src/util/planFeatures',{assertPlanFeature:async()=>({license:{plan:{code:plan},business:{id_business:'tenant',plan},limits:{}}})});
const dashboard=require('../../src/Dao/mysql/businessDashboard.dao');
const resolve=options=>resolveDashboardAccess('tenant','actor',options);
(async()=>{
 for(plan of ['basic','pro']){
  const context=await dashboard.resolveDashboardContext('tenant','basic_dashboard',{actorLoginId:'actor'},{});
  assert.equal(context.dashboard.access.scope.mode,'tenant');assert.equal(context.dashboard.access.canSelectOwn,false,'Public dashboard contract must suppress own scope too');
  for(const scope of [undefined,'own','tenant']){const a=await resolve({scope});assert.equal(a.scope.mode,'tenant');assert.equal(a.canSelectOwn,false);assert.equal(a.canSelectTenant,true);assert.equal(a.scope.doctorProfileId,null);assert.equal(a.families.financial,false);}
  assert.equal((await resolve({scope:'foreign'})).error.status,400);
  grants=['dashboard.clinical'];const restricted=await resolve({});assert.equal(restricted.scope.mode,'own');assert.equal(restricted.canSelectTenant,false);assert.equal((await resolve({scope:'tenant'})).error.status,403);
  grants=['dashboard.scope.all'];assert.equal((await resolve({})).error.status,403,'Plan/scope cannot enable metric families');
  grants=['dashboard.scope.all','dashboard.operations','dashboard.clinical'];
 }
 plan='enterprise';assert.equal((await resolve({})).scope.mode,'own');assert.equal((await resolve({})).canSelectOwn,true);assert.equal((await resolve({scope:'tenant'})).scope.mode,'tenant');
 plan='unknown';assert.equal((await resolve({})).scope.mode,'own');
 profile=null;plan='pro';grants=['dashboard.operations'];const reception=await resolve({});assert.equal(reception.scope.mode,'tenant');assert.equal(reception.canSelectOwn,false);assert.equal(reception.families.clinical,false);
 console.log('PASS UX20: Individual/Profesional tenant-only for authorized users, explicit own normalized, Clinica retains selector, invalid/unknown plans and restricted roles preserve authorization.');
})().catch(e=>{console.error(e);process.exitCode=1;});

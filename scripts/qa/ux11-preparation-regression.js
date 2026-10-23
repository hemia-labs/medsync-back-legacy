'use strict';
// Read-only preparation regressions: no network, credentials or database access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { preparationStatus } = require('../../src/util/preparationStatus');
const ready = {
    role: 'doctor', business_ready: 1, profile_exists: 1, profile_active: 1,
    profile_name: 1, profile_license: 1, profile_signature: 1, can_issue: 1, can_sign: 1,
    has_doctor: 1, agenda_ready: 1, consent_ready: 1, prescription_ready: 1
};
const permissions = ['px.dates','documents.view','documents.sign','prescriptions.issue','prescriptions.config','clinical_history.finalize'];
const find = (state, codes, id) => preparationStatus(state, codes).steps.find(step => step.id === id);
assert.equal(preparationStatus(ready, permissions).pending, 0);
assert.equal(preparationStatus(ready, permissions).completed, 5);
const newDoctor = { ...ready, profile_exists: 0, profile_active: 0, agenda_ready: 0, prescription_ready: 0 };
assert.equal(find(newDoctor, permissions, 'agenda').action.path, '/admin?section=doctor-identity', 'Other doctors do not substitute for the actors own profile');
assert.equal(find(newDoctor, permissions, 'profile').ready, false);
assert.equal(find(newDoctor, permissions, 'authorizations').ready, false);
const noSignature = {...ready, profile_signature: 0};
assert.equal(find(noSignature, permissions, 'profile').ready, false);
assert.equal(find(noSignature, permissions, 'agenda').ready, true, 'A missing signature does not falsely disable a configured schedule');
const noIssue = {...ready, can_issue: 0};
assert.equal(find(noIssue, permissions, 'authorizations').ready, false);
assert.equal(find(noIssue, permissions, 'authorizations').action, null, 'Doctor cannot self-grant professional authority through the checklist');
assert.equal(find({...noIssue, role:'admin'}, [...permissions, 'admin.users'], 'authorizations').action.path, '/admin?section=users');
assert.equal(find({...ready, role:'assistant'}, ['px.dates','documents.view'], 'agenda').action, null);
assert.equal(preparationStatus({...ready, role:'assistant'}, ['px.dates','documents.view']).steps.some(step => step.id === 'profile'), false);
assert.ok(find(ready, ['clinical_history.finalize'], 'consent'), 'Finalizing a history also needs guidance about the consent template');
const inherited = find({...ready, prescription_ready:0, prescription_shared:1}, permissions, 'prescriptions');
assert.equal(inherited.ready, false, 'Shared preview fallback is not an issuable doctor-specific configuration');
assert.match(inherited.detail, /formato general anterior/);
assert.equal(find({...ready, profile_active: '0'}, permissions, 'profile').ready, false);
assert.equal(find({...ready, profile_active: '1'}, permissions, 'profile').ready, true);
for(const role of ['doctor','admin']) {
    assert.equal(find({...ready,role,consent_ready:0},permissions,'consent').action,null);
    assert.equal(find({...ready,role,consent_ready:0},[...permissions,'documents.config'],'consent').action.path,'/admin?section=documents');
}
console.log('PASS preparation readiness: fresh profile, permissions, authorizations, staff, current consent and legacy prescription fallback.');

function stub(modulePath, exports) {
    const id = require.resolve(modulePath);
    require.cache[id] = {id, filename:id, loaded:true, exports};
}
const completeDays=Array.from({length:7},(_,day)=>({profile_id:'doctor-a',owner_id:'actor-a',profile_active:1,user_active:1,config_id:'config-a',enabled:1,revision:2,duration:30,business_config_id:'config-clinic',business_enabled:1,business_revision:4,timezone:'America/Mexico_City',day_id:'day-'+day,day_of_week:day,day_enabled:day===1?1:0,range_id:day===1?'range-a':null,start_time:'09:00',end_time:'12:00'}));
let queryCalls = 0, permissionCalls = 0, scenario = 'own', fixtureDays=completeDays;
stub('../../src/db/Sequelize.connection', { async query(sql, options) {
    queryCalls++;
    assert.match(sql, /^SELECT\b/, 'Preparation endpoint cannot mutate data');
    if(sql.includes('AS business_config_id')) {
        assert.match(sql,/WHERE l.id_business=:business AND/);
        assert.match(sql,/ac.id_business=l.id_business/);
        assert.equal(options.replacements.business,'tenant-a');
        return fixtureDays;
    }
    assert.match(sql, /WHERE l.id_login=:login AND l.id_business=:business AND l.active=1/);
    assert.match(sql, /d.id_business=l.id_business AND d.id_login=l.id_login/);
    assert.match(sql, /dt.id_business=b.id_business/);
    assert.match(sql, /pc.doctor_profile_id COLLATE .*?=d.id_doctor_professional_profile COLLATE/s);
    assert.deepEqual(options.replacements, {business:'tenant-a', login:'actor-a'});
    if(scenario === 'throw') throw Error('Internal SQL details must not be exposed');
    return scenario === 'foreign' ? [] : [{...ready}];
} });
stub('../../src/util/effectivePermissions', { async rows(login, options) {
    permissionCalls++;
    assert.equal(login, 'actor-a');
    assert.equal(options.enabledCatalog, true);
    return permissions.map(code => ({code}));
}, isTenantAdministrator: async () => false });
const dao = require('../../src/Dao/mysql/preparation.dao');
(async () => {
    assert.equal((await dao.current('', 'actor-a')).status, 403);
    assert.equal(queryCalls, 0, 'Missing tenant is rejected before SQL');
    const own = await dao.current('tenant-a', 'actor-a');
    assert.equal(own.status, 200);
    assert.deepEqual(Object.keys(own.data).sort(), ['completed','pending','steps']);
    assert.doesNotMatch(JSON.stringify(own), /signature_image|professional_license|id_login|actor-a|tenant-a/, 'Only readiness and contextual guidance leave the endpoint');
    let template={template:null,source:null},passiveReads=0;
    stub('../../src/Dao/mysql/clinicalHistoryTemplate.dao',{getCurrentTemplateForBusiness:async tenant=>{assert.equal(tenant,'tenant-a');passiveReads++;return template;},current:()=>{throw Error('Audited view must not be called');}});
    assert.equal((await dao.current('tenant-a','actor-a',{clinicalHistory:true})).data.clinicalHistory.state,'restricted');
    assert.equal(passiveReads,0);
    permissions.push('clinical_history_template.view');
    assert.equal((await dao.current('tenant-a','actor-a',{clinicalHistory:true})).data.clinicalHistory.state,'absent');
    template={source:'SYSTEM',template:{id_clinical_history_template:'initial',version_number:1,schema_json:{sections:[{key:'history',label:'Historia',fields:[]}]}}};
    const clinical=await dao.current('tenant-a','actor-a',{clinicalHistory:true});
    assert.equal(clinical.data.clinicalHistory.state,'available');assert.equal(clinical.data.clinicalHistory.source,'SYSTEM');
    assert.equal('schema_json' in clinical.data.clinicalHistory,false);assert.deepEqual(clinical.data.steps,own.data.steps);
    template.template.schema_json.sections=[];
    assert.equal((await dao.current('tenant-a','actor-a',{clinicalHistory:true})).data.clinicalHistory.state,'incomplete');
    permissions.pop();
    const priorPermissions=permissionCalls;
    console.log('PASS F/G passive clinical template: permission, absence, usable base, malformed schema, metadata only and unchanged legacy contract (doubles).');
    scenario = 'foreign';
    assert.equal((await dao.current('tenant-a', 'actor-a')).status, 403);
    assert.equal(permissionCalls, priorPermissions, 'Foreign or absent actor is rejected before permissions/readiness');
    scenario = 'throw';
    const failure = await dao.current('tenant-a', 'actor-a');
    assert.equal(failure.status, 500);
    assert.doesNotMatch(failure.message, /SQL|Internal/);
    scenario = 'own';
    stub('../../src/Dao/mysql/business.dao', {});
    stub('../../src/util/licenseLimits', { getBusinessEffectiveLicense: async () => null });
    const controller = require('../../src/controller/mysql/business.controller');
    let status, data;
    const headers = {};
    const res = { set(key, value) { headers[key] = value; return this; }, status(value) {status=value; return this;}, send(value) {data=value; return this;} };
    await controller.preparation({tokenDecode:{id_business:'tenant-a',id_login:'actor-a'}, body:{id_business:'foreign'}, query:{business:'foreign', login:'foreign'}}, res);
    assert.equal(status, 200);
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(data.data.pending, 0);
    const routes = fs.readFileSync(require.resolve('../../src/routes/mysql/business'), 'utf8');
    assert.match(routes, /router.get\('\/preparation', Token.Auth, requireTenantOperational, awaitHandlerFactory\(BusinessController.preparation\)\)/);
    console.log('PASS preparation security: actor/tenant constraints, missing/foreign sessions, token scope ignores body/query, no-store, generic failures and no writes.');
    const {evaluateAgenda} = require('../../src/domain/appointments/preparation');
    const workingDays = Array.from({length:7},(_,dayOfWeek)=>({dayOfWeek,enabled:dayOfWeek===1,timeRanges:dayOfWeek===1?[{startTime:'09:00',endTime:'12:00'}]:[]}));
    const input={subject:'doctor-a',profileActive:true,individual:{enabled:true,revision:2,defaultAppointmentDuration:30,workingDays},business:{enabled:true,revision:4,timezone:'America/Mexico_City'},capabilities:{book:true}};
    assert.equal(evaluateAgenda(input).canBookDefaultDuration,true);
    assert.equal(evaluateAgenda({...input,individual:null}).configurationState,'absent');
    assert.equal(evaluateAgenda({...input,individual:{...input.individual,workingDays:[]}}).configurationState,'incomplete');
    assert.equal(evaluateAgenda({...input,business:{...input.business,timezone:undefined}}).requirements.timezone,false);
    assert.equal(evaluateAgenda({...input,individual:{...input.individual,enabled:false}}).canBookDefaultDuration,false);
    for(const duration of [5,240,4,241])assert.equal(evaluateAgenda({...input,individual:{...input.individual,defaultAppointmentDuration:duration}}).requirements.duration,[5,240].includes(duration));
    const duplicateDays=JSON.parse(JSON.stringify(input));duplicateDays.individual.workingDays[6].dayOfWeek=0;
    assert.equal(evaluateAgenda(duplicateDays).requirements.hours,false);
    const corruptDay=JSON.parse(JSON.stringify(input));corruptDay.individual.workingDays[0].timeRanges=[{startTime:'bad',endTime:'12:00'}];
    assert.equal(evaluateAgenda(corruptDay).requirements.hours,false);
    const allClosed={...input,individual:{...input.individual,workingDays:workingDays.map(d=>({...d,enabled:false}))}};
    assert.equal(evaluateAgenda(allClosed).configurationState,'valid');assert.equal(evaluateAgenda(allClosed).hasUsualSlot,false);
    const short=JSON.parse(JSON.stringify(input));short.individual.workingDays[1].timeRanges[0].endTime='09:10';
    assert.equal(evaluateAgenda(short).configurationState,'valid');assert.equal(evaluateAgenda(short).hasUsualSlot,false);
    const {validateAppointment}=require('../../src/domain/appointments/agendaRules');
    assert.equal(validateAppointment({date:'2026-10-26',startTime:'09:00',endTime:'09:05',status:'confirmed'},short.individual),'','Diagnostic does not forbid currently valid shorter intervals');
    const connection=require('../../src/db/Sequelize.connection'), legacyQuery=connection.query;
    let detailCalls=0, foreign=false;
    connection.query=async(sql,options)=>{
        if(!sql.includes('AS business_config_id')) return legacyQuery(sql,options);
        detailCalls++;assert.match(sql,/^SELECT/);assert.doesNotMatch(sql,/CALL |INSERT |UPDATE |FOR UPDATE/i);
        assert.match(sql,/WHERE l.id_business=:business AND \(l.id_login=:login OR d.id_doctor_professional_profile=:target\)/);
        assert.equal(options.replacements.business,'tenant-a');assert.equal(options.replacements.target,'doctor-a');
        if(foreign) return [];
        return workingDays.map(day=>({profile_id:'doctor-a',owner_id:'actor-a',profile_active:1,user_active:1,config_id:'config-a',enabled:1,revision:2,duration:30,business_config_id:'config-clinic',business_enabled:1,business_revision:4,timezone:'America/Mexico_City',day_id:`day-${day.dayOfWeek}`,day_of_week:day.dayOfWeek,day_enabled:day.enabled,range_id:day.enabled?'range-a':null,start_time:'09:00',end_time:'12:00'}));
    };
    const expanded=await dao.current('tenant-a','actor-a',{agenda:true,doctorProfileId:'doctor-a'});
    assert.equal(expanded.status,200);assert.deepEqual(expanded.data.steps,own.data.steps);
    assert.equal(expanded.data.completed,own.data.completed);assert.equal(expanded.data.agenda.canBookDefaultDuration,true);
    assert.equal(expanded.data.agenda.capabilities.configureOwn,true);
    assert.doesNotMatch(JSON.stringify(expanded.data.agenda),/owner_id|signature|start_time|workingDays/);
    foreign=true;assert.equal((await dao.current('tenant-a','actor-a',{agenda:true,doctorProfileId:'doctor-a'})).status,403);
    const count=detailCalls;assert.equal((await dao.current('tenant-a','actor-a',{agenda:true,doctorProfileId:['doctor-a']})).status,400);assert.equal(detailCalls,count);
    foreign=false;connection.query=legacyQuery;
    fixtureDays=completeDays.filter(day=>day.day_of_week!==0);
    const partialSummary=await dao.current('tenant-a','actor-a');
    const partialDetail=await dao.current('tenant-a','actor-a',{agenda:true});
    assert.equal(partialSummary.data.steps.find(step=>step.id==='agenda').ready,false);
    assert.equal(partialDetail.data.agenda.configurationState,'incomplete');
    assert.deepEqual(partialSummary.data.steps,partialDetail.data.steps);
    assert.match(partialSummary.data.steps.find(step=>step.id==='agenda').detail,/Falta guardar domingo/);
    assert.equal(partialDetail.data.agenda.issues[0].code,'MISSING_DAYS');
    for(const badRows of [completeDays.map(row=>({...row,duration:2})),completeDays.map(row=>({...row,enabled:0})),completeDays.map(row=>({...row,day_of_week:row.day_of_week===0?1:row.day_of_week}))]){
        fixtureDays=badRows;const summary=await dao.current('tenant-a','actor-a'),detail=await dao.current('tenant-a','actor-a',{agenda:true});
        assert.equal(summary.data.steps.find(step=>step.id==='agenda').ready,detail.data.agenda.canBookDefaultDuration);
        assert.equal(summary.data.steps.find(step=>step.id==='agenda').ready,false);
    }
    fixtureDays=completeDays;
    console.log('PASS UX24: summary and guide agree for missing/duplicate days, invalid duration and inactive schedules. Read-only queries.');
    console.log('PASS CO23 CP1: additive contract, persisted structure/activation/usual slot, target tenant, malformed selector, SELECT-only detail and unchanged short-interval policy (doubles; no SQL execution).');
})().catch(error => { console.error(error); process.exitCode = 1; });

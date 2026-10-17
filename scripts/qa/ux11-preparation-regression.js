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
console.log('PASS preparation readiness: fresh profile, permissions, authorizations, staff, current consent and legacy prescription fallback.');

function stub(modulePath, exports) {
    const id = require.resolve(modulePath);
    require.cache[id] = {id, filename:id, loaded:true, exports};
}
let queryCalls = 0, permissionCalls = 0, scenario = 'own';
stub('../../src/db/Sequelize.connection', { async query(sql, options) {
    queryCalls++;
    assert.match(sql, /^SELECT\b/, 'Preparation endpoint cannot mutate data');
    assert.match(sql, /WHERE l.id_login=:login AND l.id_business=:business AND l.active=1/);
    assert.match(sql, /d.id_business=l.id_business AND d.id_login=l.id_login/);
    assert.match(sql, /dt.id_business=b.id_business/);
    assert.match(sql, /ac.id_business=b.id_business/);
    assert.match(sql, /pc.doctor_profile_id COLLATE .*?=d.id_doctor_professional_profile COLLATE/s);
    assert.deepEqual(options.replacements, {business:'tenant-a', login:'actor-a'});
    if(scenario === 'throw') throw Error('Internal SQL details must not be exposed');
    return scenario === 'foreign' ? [] : [ready];
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
    scenario = 'foreign';
    assert.equal((await dao.current('tenant-a', 'actor-a')).status, 403);
    assert.equal(permissionCalls, 1, 'Foreign or absent actor is rejected before permissions/readiness');
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
})().catch(error => { console.error(error); process.exitCode = 1; });

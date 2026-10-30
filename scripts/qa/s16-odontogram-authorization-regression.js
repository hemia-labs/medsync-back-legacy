const assert = require('node:assert/strict');
const express = require('express');
const stub = (modulePath, exports) => { const id = require.resolve(modulePath); require.cache[id] = { id, filename: id, loaded: true, exports }; };
let permitted = true, queries = 0, controllerCalls = 0;
const people = { own: 'tenant', colleague: 'tenant', archived: 'tenant', foreign: 'other-tenant' };
const references = { tooth: { id_person: 'own', id_tooth: '12' }, otherTooth: { id_person: 'foreign', id_tooth: '12' }, plan: { id_person: 'own' }, otherPlan: { id_person: 'foreign' }, detail: { id_person: 'own', id_tooth: '12' }, otherDetail: { id_person: 'foreign', id_tooth: '12' } };
stub('../../src/db/Sequelize.connection', { async query(sql, options) {
    if (/SELECT odontogram_mode/.test(sql)) {
        assert.equal(options.replacements.business, 'tenant');
        return [{ odontogram_mode: 'v1' }];
    }
    queries++;
    assert.match(sql, /id_business.*:business/, 'Every authorization query must constrain business');
    const values = options.replacements;
    if (values.id) {
        const row = references[values.id];
        return row && people[row.id_person] === values.business ? [row] : [];
    }
    return people[values.patient] === values.business && !(values.patient === 'archived' && /active = 1/.test(sql)) ? [{ id_person: values.patient }] : [];
} });
stub('../../src/Dao/mysql/user.dao', { hasPermission: async (id, permission) => { assert.equal(permission, 'px.tab.odontogram'); return permitted; } });
stub('../../src/util/effectivePermissions', { hasPermission: async (id, permission, options) => { assert.equal(permission, 'px.tab.odontogram'); assert.equal(options.enabledCatalog, true); return permitted; } });
stub('../../src/services/security/securityLogger.service', { record() {} });
stub('../../src/auth/authenticate', { Auth(req, res, next) { req.tokenDecode = { id_login: 'user', id_business: 'tenant' }; next(); } });
stub('../../src/middleware/requireTenantOperational.middleware', (req, res, next) => next());
stub('../../src/middleware/csrf.middleware', { csrfProtection: () => (req, res, next) => next() });
stub('../../src/middleware/awaitHandlerFactory.middleware', handler => handler);
const success = (req, res) => { controllerCalls++; res.json({ ok: true }); };
stub('../../src/controller/mysql/odontogram.controller', Object.fromEntries(['SaveTooth', 'UpdateTooth', 'getByidTooht', 'GetCatTypeTooth', 'saveOdontogramv1', 'saveOdontogramvDetailV1', 'getOdontogram', 'getValidator', 'getHistoryv1', 'updateStatusOdontogramV1', 'deleteOdontogramV1'].map(name => [name, success])));
stub('../../src/controller/mysql/tooth.controller', { getTeeth: success });
const app = express(); app.use(express.json());
app.use('/odontogram', require('../../src/routes/mysql/odontogram'));
app.use('/teeth', require('../../src/routes/mysql/teeth'));
const cases = [
    ['POST', '/odontogram/save', { id_person: 'own', id_tooth: '12', symbol: '1', observation: 'QA', config: [] }],
    ['PUT', '/odontogram/update', { id_person: 'own', id_odontogram: 'tooth', id_tooth: '12', symbol: '1', observation: 'QA', config: [] }],
    ['GET', '/odontogram/get/tooth/own/12'], ['GET', '/odontogram/getcatypetooth'],
    ['POST', '/odontogram/v1/save', { id_person: 'own', type: 'PERMANENT' }],
    ['POST', '/odontogram/v1/detail', { id_person: 'own', id_odontogram_detailv1: 'detail', id_tooth: '12', treatment: 'QA' }],
    ['GET', '/odontogram/v1/odontogram/own'], ['GET', '/odontogram/v1/validate/own'], ['GET', '/odontogram/v1/history/own'],
    ['PUT', '/odontogram/v1/status', { id_odontogramv1: 'plan', active: true }],
    ['DELETE', '/odontogram/v1/delete', { id_odontogramv1: 'plan' }],
    ['GET', '/teeth/list/own'], ['GET', '/teeth/list/own/PERMANENT']
];
(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async ([method, route, body]) => fetch(base + route, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    try {
        permitted = false;
        for (const scenario of cases) assert.equal((await request(scenario)).status, 403, `Permission required: ${scenario[1]}`);
        assert.equal(queries, 0); assert.equal(controllerCalls, 0, 'Forbidden role never reaches clinical data or procedures');
        permitted = true;
        for (const scenario of cases) assert.equal((await request(scenario)).status, 200, `Authorized path unchanged: ${scenario[1]}`);
        const authorizedCalls = controllerCalls;
        for (const scenario of cases.filter(item => item[1] !== '/odontogram/getcatypetooth')) {
            const attack = JSON.parse(JSON.stringify(scenario));
            attack[1] = attack[1].replace('/own', '/foreign');
            if (attack[2]) {
                if (attack[2].id_person) attack[2].id_person = 'foreign';
                if (attack[2].id_odontogram) attack[2].id_odontogram = 'otherTooth';
                if (attack[2].id_odontogramv1) attack[2].id_odontogramv1 = 'otherPlan';
                if (attack[2].id_odontogram_detailv1) attack[2].id_odontogram_detailv1 = 'otherDetail';
            }
            assert.equal((await request(attack)).status, 403, `Cross-tenant blocked: ${attack[1]}`);
        }
        assert.equal(controllerCalls, authorizedCalls);
        const detail = cases[5];
        assert.equal((await request([detail[0], detail[1], { ...detail[2], id_person: 'colleague' }])).status, 403, 'Cannot mix detail with a different patient in the same tenant');
        assert.equal((await request([detail[0], detail[1], { ...detail[2], id_tooth: '13' }])).status, 403, 'Cannot apply a detail to a mismatched tooth');
        assert.equal((await request([detail[0], detail[1], { ...detail[2], id_odontogram_detailv1: '' }])).status, 200, 'Creating a new detail without an id remains supported');
        assert.equal((await request(['GET', '/odontogram/v1/history/archived'])).status, 200, 'Archival preserves authorized clinical history consultation');
        assert.equal((await request(['GET', '/teeth/list/archived'])).status, 200);
        assert.equal((await request(['POST', '/odontogram/v1/save', { id_person: 'archived', type: 'PERMANENT' }])).status, 403, 'Archived patients cannot acquire new odontograms');
        console.log('PASS S16 odontogram: all 13 real routes require permission, tenant isolation before controller, patient/detail/tooth consistency, archived read/write distinction and valid existing/create flows. Mock authentication/storage; no DB writes.');
    } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

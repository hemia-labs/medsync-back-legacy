const assert = require('node:assert/strict');
const express = require('express');

// Real router, validators, authorization middleware, controller and catalog DAO.
// Only authentication, permission storage, SQL and legacy procedure calls are mocked.
const stub = (modulePath, exports) => {
    const id = require.resolve(modulePath);
    require.cache[id] = { id, filename: id, loaded: true, exports };
};
const allPermissions = ['treatments.view', 'treatments.create', 'treatments.edit', 'treatments.cancel', 'treatments.cost_view', 'treatments.cost_edit'];
let permissions = new Set(), queries = [], procedureCalls = 0, failQuery = false;
const patients = { own: 'tenant', colleague: 'tenant', foreign: 'other-tenant', archived: 'tenant' };
const treatments = { treatment: 'own', colleagueTreatment: 'colleague', foreignTreatment: 'foreign' };
const details = { detail: 'own', otherDetail: 'own', colleagueDetail: 'colleague', foreignDetail: 'foreign' };
const diagnoses = {
    diagnosis: { patient: 'own', detail: 'detail' },
    colleagueDiagnosis: { patient: 'colleague', detail: 'colleagueDetail' },
    foreignDiagnosis: { patient: 'foreign', detail: 'foreignDetail' }
};
stub('../../src/db/Sequelize.connection', { async query(sql, options) {
    queries.push({ sql, values: options.replacements });
    if (failQuery) throw new Error('QA storage unavailable');
    const values = options.replacements;
    if (/FROM person\b/.test(sql)) {
        assert.match(sql, /id_business.*:business/);
        const activeActor = !values.actor || values.actor === 'user';
        return activeActor && patients[values.patient] === values.business && values.patient !== 'archived'
            ? [{ id_person: values.patient }] : [];
    }
    if (/FROM treatment\b/.test(sql)) return values.ids.filter(id => treatments[id] === values.patient).map(id => ({ id_treatment: id }));
    if (/FROM odontogramDetailv1 od/.test(sql)) {
        assert.match(sql, /JOIN odontogramv1 o/);
        assert.match(sql, /o\.id_person.*:patient/);
        return details[values.id] === values.patient ? [{ id_odontogram_detailv1: values.id }] : [];
    }
    if (/FROM diagnosisV1\b/.test(sql)) {
        assert.match(sql, /id_odontogram_detailv1.*:odontogram/);
        const row = diagnoses[values.id];
        return row && row.patient === values.patient && row.detail === values.odontogram ? [{ id_diagnosisv1: values.id }] : [];
    }
    if (/FROM patient_treatment pt/.test(sql)) {
        assert.equal(values._id_business, 'tenant');
        assert.equal(values._id_person, 'own');
        assert.match(sql, /tp\.status = 'active'/);
        assert.match(sql, /pt\.active = 1/);
        assert.match(sql, /ptt\.id_business = pt\.id_business/);
        assert.doesNotMatch(sql, /\b(amount|cost|signature|license)\b/i, 'Monitoring catalog does not select finances or signatures');
        return [{ id: 'planTreatment', name: 'QA treatment', status: 'pending', id_treatment_plan: 'plan', teeth: '12,13' },
            { id: 'generalTreatment', name: 'QA general', status: 'in_progress', id_treatment_plan: 'plan', teeth: null }];
    }
    assert.fail(`Unexpected SQL in isolated test: ${sql}`);
} });
stub('../../src/util/effectivePermissions', { rows: async () => [...permissions].map(code => ({ code })) });
stub('../../src/Dao/mysql/user.dao', { hasPermission: async (id, code) => permissions.has(code) });
stub('../../src/services/security/securityLogger.service', { record() {} });
stub('../../src/Dao/mysql/treatmentPlan.dao', class {});
stub('../../src/auth/authenticate', { Auth(req, res, next) { req.tokenDecode = { id_login: 'user', id_business: 'tenant' }; next(); } });
stub('../../src/middleware/requireTenantOperational.middleware', (req, res, next) => next());
stub('../../src/middleware/csrf.middleware', { csrfProtection: () => (req, res, next) => next() });
stub('../../src/middleware/awaitHandlerFactory.middleware', handler => handler);
const dao = require('../../src/Dao/mysql/treatment.Dao');
for (const method of ['getTreatment', 'saveTreatment', 'UpdateTreatment', 'DeleteTreatment', 'getDiagnosis', 'saveDiagnosis']) {
    dao[method] = async () => { procedureCalls++; return { status: 200, data: [], message: 'QA success' }; };
}
const app = express(); app.use(express.json());
app.use('/treatment', require('../../src/routes/mysql/treatment'));
app.use((error, req, res, next) => res.status(500).json({ message: error.message }));
const baseTreatment = { id_person: 'own', treatment: [{ description: 'QA', amount: 0 }] };
const baseDiagnosis = { id_person: 'own', id_diagnosis: 'diagnosis', id_odontogram: 'detail', treatment: 'QA', amount: 0 };
const routes = [
    ['GET', '/list/own', undefined, ['treatments.view', 'treatments.cost_view']],
    ['POST', '/save', baseTreatment, ['treatments.create', 'treatments.cost_edit']],
    ['PUT', '/update', { id_person: 'own', treatment: [{ id_treatment: 'treatment', description: 'QA', amount: 0 }] }, ['treatments.edit', 'treatments.cost_edit']],
    ['DELETE', '/delete', { id_person: 'own', id_treatment: 'treatment' }, ['treatments.cancel']],
    ['GET', '/diagnosis/get/own', undefined, ['treatments.view', 'treatments.cost_view']],
    ['POST', '/diagnosis/save', baseDiagnosis, ['treatments.edit', 'treatments.cost_edit']]
];

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/treatment`;
    const request = async ([method, path, body]) => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const status = async (scenario, expected, message) => assert.equal((await request(scenario)).status, expected, message);
    try {
        for (const scenario of routes) {
            for (const missing of scenario[3]) {
                permissions = new Set(scenario[3].filter(code => code !== missing));
                const beforeQueries = queries.length, beforeCalls = procedureCalls;
                await status(scenario, 403, `${scenario[1]} requires ${missing}`);
                assert.equal(queries.length, beforeQueries, 'Denied permission makes no clinical query');
                assert.equal(procedureCalls, beforeCalls, 'Denied permission invokes no procedure');
            }
        }
        permissions = new Set(allPermissions);
        for (const scenario of routes) await status(scenario, 200, `Authorized compatibility route: ${scenario[1]}`);
        assert.equal(procedureCalls, routes.length);
        assert(queries.some(query => /FROM diagnosisV1/.test(query.sql)), 'Diagnosis editing checks the V1 row used by the procedure');

        const goodCalls = procedureCalls;
        for (const scenario of routes) {
            const foreign = JSON.parse(JSON.stringify(scenario));
            foreign[1] = foreign[1].replace('/own', '/foreign');
            if (foreign[2]) foreign[2].id_person = 'foreign';
            await status(foreign, 403, `Cross-tenant ${scenario[1]}`);
        }
        await status(['PUT', '/update', { ...baseTreatment, treatment: [{ id_treatment: 'colleagueTreatment', description: 'QA', amount: 1 }] }], 403, 'Cannot change a colleague patient treatment using own patient');
        await status(['DELETE', '/delete', { id_person: 'own', id_treatment: 'foreignTreatment' }], 403);
        await status(['POST', '/diagnosis/save', { ...baseDiagnosis, id_odontogram: 'colleagueDetail' }], 403, 'Detail must belong to same patient');
        await status(['POST', '/diagnosis/save', { ...baseDiagnosis, id_diagnosis: 'colleagueDiagnosis' }], 403, 'Diagnosis must belong to same patient');
        await status(['POST', '/diagnosis/save', { ...baseDiagnosis, id_odontogram: 'otherDetail' }], 403, 'Diagnosis must refer to same V1 detail');
        await status(['POST', '/save', { ...baseTreatment, id_business: 'other-tenant', id_person: 'foreign' }], 403, 'Payload cannot override token tenant');
        assert.equal(procedureCalls, goodCalls, 'No mismatched reference reaches a procedure');
        for (const empty of [null, '']) await status(['POST', '/diagnosis/save', { ...baseDiagnosis, id_diagnosis: empty }], 400, 'Legacy required ID validator still rejects empty diagnosis IDs before scope');
        await status(['POST', '/save', baseTreatment], 200, 'New generic treatment without an ID remains supported');

        const context = { id_person: 'own', id_business: 'tenant', id_login: 'user' };
        permissions = new Set();
        let beforeQueries = queries.length;
        assert.equal((await dao.catTreatment(context)).status, 403);
        assert.equal(queries.length, beforeQueries);
        await status(['GET', '/cat/list/own'], 403);
        permissions = new Set(['px.tab.monitoring']);
        const catalogResponse = await request(['GET', '/cat/list/own']);
        assert.equal(catalogResponse.status, 200, 'Monitoring alone can select treatments without cost permission');
        const catalog = (await catalogResponse.json()).data;
        assert.deepEqual(catalog[0].teeth, ['12', '13']);
        assert.deepEqual(catalog[1].teeth, []);
        assert.deepEqual(Object.keys(catalog[0]).sort(), ['id', 'id_treatment_plan', 'name', 'status', 'teeth']);
        await status(['GET', '/list/own'], 403, 'Monitoring cannot access monetary compatibility listing');
        for (const patient of ['foreign', 'archived']) {
            beforeQueries = queries.length;
            assert.equal((await dao.catTreatment({ ...context, id_person: patient })).status, 403);
            assert.equal(queries.length, beforeQueries + 1, 'Catalog ownership denial never queries treatments');
        }
        assert.equal((await dao.catTreatment({ ...context, id_login: 'inactive' })).status, 403);
        permissions = new Set(['treatments.view']);
        assert.equal((await dao.catTreatment(context)).status, 200, 'Treatment view also permits safe catalog');
        assert.equal((await dao.catTreatment({ id_person: 'own' })).status, 403, 'Catalog requires full authenticated context');

        permissions = new Set(allPermissions); failQuery = true;
        const beforeFailureCalls = procedureCalls;
        await status(['GET', '/list/own'], 500, 'Scope query failures cannot reach procedures');
        assert.equal(procedureCalls, beforeFailureCalls);
        console.log('PASS S18 legacy treatment: six real HTTP routes require clinical/cost permissions, patient tenant ownership and matching treatment/V1 diagnosis/detail; safe monitoring catalog checked through real DAO. Empty diagnosis creation remains rejected by existing validator. Mock storage; no DB connection or writes.');
    } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// Real DAOs, SQL responses and connections simulated in memory. No env or DB.
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('sequelize-pool');
const context = new AsyncLocalStorage();
let mode = 'pool', granted = false, profile = null, permissionRows = [], calls = [];
let serial = 0, nestedLeases = 0;
const pool = new Pool({ name: 'po12', create: async () => ({ id: ++serial }),
    destroy: async () => {}, validate: () => true, max: 5, min: 0,
    acquireTimeoutMillis: 300, idleTimeoutMillis: 300 });
function fixture(sql, options) {
    if (sql.includes('INNER JOIN cat_permission cp')) {
        if (mode === 'pool') return granted ? [{ allowed: 1 }] : [];
        return permissionRows.filter(row => !sql.includes('AND cp.is_active = 1') || row.is_active === 1);
    }
    if (mode === 'home') {
        if (sql.includes('FROM login l LEFT JOIN doctor_professional_profile')) return [{ id_login: 'actor', id_doctor_professional_profile: profile }];
        return [];
    }
    if (sql.includes('SELECT id_person, id_business, name, surname, birthday')) return [{ id_person: 'patient', name: 'Synthetic', surname: 'Patient', age: 26 }];
    if (sql.includes('SELECT dt.*, dtv.')) return [{ id_document_template: 'template', id_document_template_version: 'version',
        version_number: 1, template_type: 'CUSTOM', content_html: '<p>{{nombrePaciente}}</p>' }];
    if (sql.includes('SELECT l.id_login, l.name, r.code AS rol')) return [{ id_login: 'actor', rol: 'admin' }];
    if (sql.includes('SELECT dpp.*, l.name')) return [{ id_login: 'doctor', is_active: 1, professional_name: 'Synthetic Doctor',
        professional_license: 'QA', can_sign_documents: 1, signature_image: 'synthetic' }];
    return [];
}
const db = {
    async transaction() {
        const resource = await pool.acquire(), store = context.getStore();
        assert.ok(store, 'Every test request has independent context');
        assert.equal(store.transaction, undefined);
        const transaction = {
            finished: false,
            async commit() { finish('commit'); }, async rollback() { finish('rollback'); }
        };
        function finish(state) {
            assert.equal(transaction.finished, false, 'Transaction released exactly once');
            transaction.finished = state;
            store.transaction = undefined;
            pool.release(resource);
        }
        store.transaction = transaction;
        return transaction;
    },
    async query(sql, options = {}) {
        calls.push({ sql, options });
        if (mode === 'home') return fixture(sql, options);
        const current = context.getStore().transaction;
        if (current && options.transaction !== current) {
            nestedLeases++;
            throw new Error('Query escaped its transaction connection');
        }
        const resource = options.transaction ? null : await pool.acquire();
        try { await new Promise(resolve => setImmediate(resolve)); return fixture(sql, options); }
        finally { if (resource) pool.release(resource); }
    }
};
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../../src/db/Sequelize.connection', db);
stub('../../src/config/config', {});
const effective = require('../../src/util/effectivePermissions');
stub('../../src/Dao/mysql/user.dao', { hasPermission: effective.hasPermission });
stub('../../src/Dao/mysql/appointment.Dao', {});
const prescription = require('../../src/Dao/mysql/prescription.dao');
const history = require('../../src/Dao/mysql/clinicalHistory.dao');
const template = require('../../src/Dao/mysql/clinicalHistoryTemplate.dao');
const document = require('../../src/Dao/mysql/document.dao');
const home = require('../../src/Dao/mysql/homeContinuity.dao');
const body = { id_login: 'actor', id_business: 'tenant', patient_id: 'patient', id_person: 'patient',
    id_prescription: 'missing', id_clinical_history: 'missing', template_id: 'missing',
    responsible_doctor_user_id: 'doctor', id_document_template: 'template' };
async function concurrent(label, operation, allow) {
    granted = allow; calls = [];
    const results = await Promise.all(Array.from({ length: 5 }, () => context.run({}, () => operation({ ...body }))));
    assert.ok(results.every(result => result.status < 500), label + ': ' + JSON.stringify(results));
    assert.equal(pool.using, 0, label + ' releases all connections');
    assert.equal(pool.waiting, 0);
    if (!allow) assert.equal(calls.filter(call => !call.sql.includes('INNER JOIN cat_permission cp')).length, 0, 'Denied requests read no clinical rows');
}
(async () => {
    let scenarios = 0;
    for (const [label, operation] of [
        ['prescription.save', body => prescription.save(body)], ['prescription.issue', body => prescription.issue(body)],
        ['prescription.cancel', body => prescription.cancel(body)], ['history.create', body => history.createDraft(body)],
        ['history.update', body => history.updateDraft(body)], ['history.finalize', body => history.finalize(body)],
        ['history.print', body => history.markPrinted(body)], ['history.cancel', body => history.cancel(body)],
        ['template.create', body => template.createBusinessTemplate(body)], ['template.version', body => template.createVersion(body)],
        ['history.detail-within-transaction', async body => {
            const transaction = await db.transaction();
            try { return await history.getById(body, transaction); }
            finally { await transaction.rollback(); }
        }]
    ]) for (const allow of [false, true]) { await concurrent(label, operation, allow); scenarios++; }
    await concurrent('document.create', body => document.createDocument(body), true);
    assert.ok(calls.some(call => call.sql.includes('SELECT dpp.*, l.name') && call.options.transaction), 'Creation reaches doctor lookup inside transaction');
    assert.ok(calls.some(call => call.sql.includes('SELECT name, legal_name, phone, address') && call.options.transaction), 'Creation reaches business context inside transaction');
    assert.equal(nestedLeases, 0);
    mode = 'home';
    const all = ['px.all', 'px.dates', 'clinical_history.view', 'prescriptions.view.all', 'documents.view',
        'dashboard.operations', 'dashboard.clinical', 'dashboard.scope.all'];
    const measurements = [];
    for (const [label, codes, doctor, expected] of [
        ['admin', all, null, 13], ['doctor', all, 'profile', 11],
        ['reception', ['px.all', 'px.dates', 'dashboard.operations'], null, 5]
    ]) {
        permissionRows = codes.map(code => ({ code, is_active: 1 })); profile = doctor; calls = [];
        const result = await home.summary('tenant', 'actor');
        assert.equal(result.status, 200, result.message);
        assert.equal(calls.length, expected);
        assert.equal(calls.filter(call => call.sql.includes('INNER JOIN cat_permission cp')).length, 1);
        measurements.push({ role: label, daoSqlCalls: calls.length, expectedWithAuthAndTenant: calls.length + 2 });
    }
    // A disabled dashboard family must not read clinical tables, even if legacy
    // module permissions still inherit is_active=false grants as before.
    profile = null;
    permissionRows = [{ code: 'documents.view', is_active: 0 }, { code: 'dashboard.clinical', is_active: 0 },
        { code: 'dashboard.scope.all', is_active: 1 }]; calls = [];
    let result = await home.summary('tenant', 'actor');
    assert.equal(result.data.families.clinical, false);
    assert.ok(!calls.some(call => /FROM (patient_documents|clinical_histories|prescription)\b/.test(call.sql)));
    permissionRows[1].is_active = 1;
    result = await home.summary('tenant', 'actor');
    assert.equal(result.data.permissions.documentsView, true, 'Legacy module grant keeps original catalog semantics');
    permissionRows = [];
    result = await home.summary('tenant', 'actor');
    assert.equal(result.data.permissions.documentsView, false, 'Next request observes revocation without persistent cache');
    console.log(JSON.stringify({ result: 'PASS', concurrentBatches: scenarios + 1, requestsPerBatch: 5,
        poolMax: 5, escapedTransactionQueries: nestedLeases, measurements, authCatalogAndRevocation: 'PASS' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await pool.drain(); await pool.destroyAllNow(); });

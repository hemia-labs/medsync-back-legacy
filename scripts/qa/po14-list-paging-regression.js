'use strict';
// Real DAOs/controllers, deterministic SQL adapter. No database, cloud or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
let calls = [], allowed = true, allPrescriptions = true, costView = true, totalDocuments = 250, totalPlans = 17, failRead = false;
let sessionActive = true, tenantStatus = 'active';
const queryTemplates = new Map();
const doc = (business, index) => ({ id_patient_document: `doc-${String(index).padStart(4, '0')}`, id_business: business,
    id_person: 'patient', id_document_template: 'template', document_type: 'GENERAL_CONSENT', origin: 'DOCUMENT_CENTER',
    title: 'Documento sintetico ' + index, created_at: index === 1 ? null : '2026-10-19 12:00:00', active: 1, status: index % 2 ? 'FIRMADO' : 'BORRADOR',
    content_html_snapshot: '<p>' + 'Contenido sintetico '.repeat(100) + '</p><script>bad()</script>',
    requires_patient_signature: 1, requires_doctor_signature: 1 });
function docs(business) { return Array.from({ length: totalDocuments }, (_, index) => doc(business, totalDocuments - index)); }
const plan = (id, active = false) => ({ id_treatment_plan: id, status: active ? 'active' : 'closed', title: id, created_at: '2026-10-19 12:00:00' });
const planList = () => Array.from({ length: totalPlans }, (_, i) => plan(`plan-${String(totalPlans - i).padStart(3, '0')}`));
const flags = () => ['view', 'create', 'edit', 'consent.view', 'consent.sign', ...(costView ? ['cost_view'] : [])].map(code => ({ code: 'treatments.' + code }));
stub('../../src/config/config', {});
stub('../../src/util/effectivePermissions', { hasPermission: async (_actor, code) => allowed && (code !== 'prescriptions.view.all' || allPrescriptions), rows: async () => allowed ? flags() : [] });
stub('../../src/db/Sequelize.connection', {
    transaction() { throw Error('Read suite must not open transactions'); },
    async query(sql, options = {}) {
        const r = options.replacements || {}, business = r._id_business || r.business || r._business;
        calls.push({ sql, options });
        queryTemplates.set(sql, { sql, parameterNames: Object.keys(r).sort() });
        if (failRead) throw Error('Injected SQL failure');
        if (sql.includes('INNER JOIN `session`')) return sessionActive ? [{ id_login: 'actor', id_business: 'tenant', id_rol: 'role', rol: 'admin', id_session: 'session' }] : [];
        if (sql.includes('FROM `session`')) return sessionActive ? [{ id_session: 'session' }] : [];
        if (sql.includes('trial_starts_at') && sql.includes('FROM business')) return [{ id_business: 'tenant', active: 1, status: tenantStatus, subscription_status: tenantStatus }];
        if (sql.includes('AS firstVisitPatients')) return [{ firstVisitPatients: 2, retainedPatients: 1 }];
        if (/FROM person\s/.test(sql) && !sql.includes('FROM prescription')) return (r._id_person || r.patient) === 'foreign' ? [] : [{ id_person: 'patient', id_business: business }];
        if (sql.includes('FROM patient_document_events')) return r._ids.map(id => ({ id_patient_document: id, notes: JSON.stringify({ version: 1, requirements: {
            requires_patient_signature: 1, requires_doctor_signature: 0, requires_tutor_signature: 0, requires_witness1_signature: 0, requires_witness2_signature: 0 } }) }));
        if (sql.includes('FROM patient_document_signatures')) return (r._ids || r.ids).map(id => ({ id_patient_document: id, signature_role: 'PATIENT', signature_image: 'original-signature', signed_at: '2026-10-19' }));
        if (sql.includes('FROM patient_documents pd')) {
            let rows = docs(business);
            if (sql.includes('ROW_NUMBER()')) return [{ id_patient_document: 'doc-0001', id_document_template: 'template', document_type: 'SENSITIVE_DATA_CONSENT', status: 'FIRMADO', title: 'Fuera de pagina' }];
            if (sql.includes("pd.status = 'FIRMADO'")) rows = rows.filter(row => row.status === 'FIRMADO');
            if (sql.includes("pd.status IN ('BORRADOR', 'PENDIENTE_FIRMA')")) rows = rows.filter(row => row.status === 'BORRADOR');
            if (r._document) rows = rows.filter(row => row.id_patient_document === r._document);
            if (sql.startsWith('SELECT pd.created_at')) return rows.filter(row => row.id_patient_document === r._focus).map(row => ({ created_at: row.created_at, id_patient_document: row.id_patient_document }));
            if (sql.includes('COUNT(*)')) return [{ total: r._focus_id ? rows.findIndex(row => row.id_patient_document === r._focus_id) : rows.length }];
            return r._limit === undefined ? rows : rows.slice(r._offset, r._offset + r._limit);
        }
        if (sql.includes('FROM prescription p')) {
            let rows = Array.from({ length: 123 }, (_, i) => ({ id_prescription: 'rx-' + (123 - i), id_business: business, created_by: i % 2 ? 'actor' : 'other', notes: 'Nota ' + i, medications: 'Medicamento sintetico' }));
            if (sql.includes('p.created_by COLLATE') && sql.includes('OR p.created_by')) rows = rows.filter(row => row.created_by === 'actor');
            if (sql.includes('COUNT(*)')) return [{ total: rows.length }];
            return r._limit === undefined ? rows : rows.slice(r._offset, r._offset + r._limit);
        }
        if (sql.includes('FROM clinical_module_config')) return [{ treatmentPlanEnabled: 1 }];
        if (sql.includes('COUNT(*) AS total FROM treatment_plan')) return [{ total: totalPlans }];
        if (sql.includes('FROM treatment_plan tp')) return sql.includes("tp.status = 'active'") ? [plan('active-plan', true)] : r.limit === undefined ? [plan('active-plan', true), ...planList()] : planList().slice(r.offset, r.offset + r.limit);
        if (sql.includes('FROM patient_treatment_tooth')) return (r.planIds || []).map(id => ({ id_patient_treatment: 'item-' + id, tooth_number: '11' }));
        if (sql.includes('FROM patient_treatment pt')) return (r.planIds || []).map(id => ({ id_treatment_plan: id, id_patient_treatment: 'item-' + id, name: 'Tratamiento', cost: 999, status: 'pending' }));
        if (sql.includes('FROM treatment_plan_consent_document link')) return (r.planIds || []).map(id => ({ id_patient_document: 'linked-' + id, treatment_plan_id: id,
            status: 'PENDIENTE_FIRMA', content_html_snapshot: '<p>Consentimiento congelado</p>', consent_snapshot_json: JSON.stringify({ includes_costs: true, signature_requirements: { requires_patient_signature: 1 } }) }));
        if (sql.includes('FROM treatment_plan_consent_version')) return (r.planIds || []).map(id => ({ id_consent_version: 'version-' + id, id_treatment_plan: id, revision: 1,
            consent_snapshot_json: JSON.stringify({ patient_signature: 'unchanged-signature' }), plan_snapshot_json: JSON.stringify({ treatments: [{ cost: 999 }] }) }));
        if (sql.includes('FROM treatment_plan_consent ')) return [];
        throw Error('Unhandled synthetic SQL: ' + sql.slice(0, 120));
    }
});
const documentDao = require('../../src/Dao/mysql/document.dao');
const prescriptionDao = require('../../src/Dao/mysql/prescription.dao');
const PlanDao = require('../../src/Dao/mysql/treatmentPlan.dao');
const planDao = new PlanDao();
const documentController = require('../../src/controller/mysql/document.controller');
const prescriptionController = require('../../src/controller/mysql/prescription.controller');
const treatmentController = require('../../src/controller/mysql/treatment.controller');
const body = { id_business: 'tenant', id_login: 'actor', id_person: 'patient' };
async function invoke(controller, method, query = {}, params = {}) {
    const req = { query: { ...query, id_business: 'forged', id_login: 'forged' }, params: { id_person: 'patient', ...params }, tokenDecode: { id_login: 'actor', id_business: 'tenant' } };
    const res = { status(code) { this.code = code; return this; }, send(value) { this.body = value; } };
    await controller[method](req, res);
    return res.body;
}
async function checkHttp() {
    process.env.REQUIRE_ACTIVE_SESSION = 'true';
    stub('../../src/config/jwt', { key: 'synthetic-po14-local-test-key', expiresIn: { expiresIn: '10m' } });
    stub('../../src/config/authCookie.config', { getAuthCookieConfig: () => ({ isCookieAuthEnabled: false }) });
    stub('../../src/services/security/securityLogger.service', { record() {} });
    delete require.cache[require.resolve('../../src/auth/authenticate')];
    const express = require('express'), Token = require('../../src/auth/authenticate');
    const token = Token.GetAccessToken({ id_login: 'actor', id_business: 'tenant', id_session: 'session' }).token;
    const app = express();
    app.use('/api/document', require('../../src/routes/mysql/document'));
    app.use('/api/prescription', require('../../src/routes/mysql/prescription'));
    app.use('/api/treatment', require('../../src/routes/mysql/treatment'));
    app.use((error, req, res, next) => res.status(500).json({ message: error.message }));
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    let checks = 0;
    try {
        async function request(route, auth = true) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers: auth ? { Authorization: 'Bearer ' + token } : {} });
            checks++; return { status: response.status, body: await response.json() };
        }
        for (const route of ['/api/document/patient/patient', '/api/prescription/list', '/api/prescription/patient/patient', '/api/treatment/plan/patient']) {
            const result = await request(route + '?page=1&page_size=5&id_business=forged');
            assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body));
            assert.equal((await request(route + '?page=0')).status, 400);
            assert.equal((await request(route, false)).status, 401);
        }
        const detail = await request('/api/document/patient/patient/doc-0001');
        assert.equal(detail.status, 200); assert.equal(detail.body.data[0].id_patient_document, 'doc-0001');
        assert.equal((await request('/api/document/patient/foreign/doc-0001')).status, 401);
        sessionActive = false; calls = [];
        assert.equal((await request('/api/document/patient/patient?page=1')).status, 401);
        assert.ok(!calls.some(call => call.sql.includes('patient_documents'))); sessionActive = true;
        tenantStatus = 'suspended';
        assert.equal((await request('/api/document/patient/patient/doc-0001')).status, 200, 'Limited tenant retains scoped document read');
        tenantStatus = 'active';
        return checks;
    } finally { sessionActive = true; tenantStatus = 'active'; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
(async () => {
    const { listPage, pageWindow } = require('../../src/util/listPage');
    assert.equal(listPage({}), null);
    for (const value of [0, -1, 1.5, [], {}, '1e2', '01', '1 OR 1', null, 1000001]) assert.throws(() => listPage({ page: value }), /INVALID_LIST_PAGE/);
    assert.throws(() => listPage({ page_size: 51 }), /INVALID_LIST_PAGE/);
    assert.equal(pageWindow(listPage({ page: '99', page_size: '10' }), 0).page, 1);
    const legacy = await documentDao.listPatientDocuments(body);
    assert.equal(legacy.status, 200); assert.equal(legacy.data.length, 250);
    calls = [];
    const paged = await invoke(documentController, 'PatientDocuments', { page: '2', page_size: '10' });
    assert.equal(paged.status, 200); assert.equal(paged.data.items.length, 10);
    assert.deepEqual(paged.data.items, legacy.data.slice(10, 20), 'Visible content, signatures and frozen requirements are preserved');
    assert.equal(paged.data.items[0].requires_doctor_signature, 0, 'Server snapshot still overrides changed template');
    assert.doesNotMatch(paged.data.items[0].content_html_snapshot, /script/);
    assert.equal(paged.data.items[0].signatures[0].signature_image, 'original-signature');
    assert.equal(paged.data.creationHints[0].id_patient_document, 'doc-0001', 'Off-page clinical warning remains available');
    const pageReads = calls.filter(call => call.sql.includes('FROM patient_document_signatures') || call.sql.includes('FROM patient_document_events'));
    assert.equal(pageReads.length, 2);
    for (const call of pageReads) assert.equal(call.options.replacements._ids.length, 10, 'No signatures/requirements for off-page documents');
    assert.ok(calls.every(call => Object.values(call.options.replacements).every(value => value !== 'forged')));
    const focused = await invoke(documentController, 'PatientDocuments', { page: '1', page_size: '10', focus_document: 'doc-0001' });
    assert.equal(focused.data.pagination.page, 25); assert.equal(focused.data.items.at(-1).id_patient_document, 'doc-0001');
    const locator = calls.find(call => call.options.replacements._focus_id);
    assert.equal(locator.options.replacements._created, null); assert.match(locator.sql, /pd.created_at <=> :_created/);
    const detail = await invoke(documentController, 'PatientDocuments', {}, { id_patient_document: 'doc-0001' });
    assert.equal(detail.data.length, 1);
    const missingDetail = await invoke(documentController, 'PatientDocuments', {}, { id_patient_document: 'foreign-id' });
    assert.deepEqual(missingDetail.data, []);
    const filtered = await invoke(documentController, 'PatientDocuments', { page: 1, document_filter: 'SIGNED' });
    assert.equal(filtered.data.pagination.total, 125); assert.ok(filtered.data.items.every(row => row.status === 'FIRMADO'));
    const last = await invoke(documentController, 'PatientDocuments', { page: 1000000, page_size: 9 });
    assert.equal(last.data.pagination.page, 28); assert.equal(last.data.items.length, 7);
    totalDocuments = 0;
    const empty = await invoke(documentController, 'PatientDocuments', { page: 9 });
    assert.deepEqual(empty.data.items, []); assert.equal(empty.data.pagination.totalPages, 1); totalDocuments = 250;
    const rxLegacy = await prescriptionDao.list(body);
    const rx = await invoke(prescriptionController, 'listByPatient', { page: 3, page_size: 10 });
    assert.equal(rx.status, 200); assert.deepEqual(rx.data.items, rxLegacy.data.slice(20, 30));
    allPrescriptions = false; calls = [];
    const own = await invoke(prescriptionController, 'list', { page: 1, search: 'sintetico', status: 'draft' });
    assert.equal(own.data.pagination.total, 61);
    const rxQueries = calls.filter(call => call.sql.includes('FROM prescription p'));
    assert.equal(rxQueries.length, 2);
    for (const call of rxQueries) assert.match(call.sql, /OR p.created_by COLLATE/);
    assert.ok(rxQueries.every(call => call.sql.includes('p.status COLLATE') && call.sql.includes('LIKE :_search')));
    allPrescriptions = true; calls = [];
    const plans = await invoke(treatmentController, 'GetTreatmentPlan', { page: 2, page_size: 5 });
    assert.equal(plans.status, 200); assert.equal(plans.data.history.length, 5); assert.equal(plans.data.activePlan.id_treatment_plan, 'active-plan');
    assert.deepEqual(plans.data.history.map(item => item.id_treatment_plan), planList().slice(5, 10).map(item => item.id_treatment_plan));
    const ids = ['active-plan', ...plans.data.history.map(item => item.id_treatment_plan)];
    const childReads = calls.filter(call => /FROM (patient_treatment |patient_treatment_tooth |treatment_plan_consent |treatment_plan_consent_version|treatment_plan_consent_document link)/.test(call.sql));
    assert.ok(childReads.length >= 5);
    for (const call of childReads) { assert.ok(call.sql.includes('IN (:planIds)')); assert.deepEqual(call.options.replacements.planIds, ids); }
    assert.ok(childReads.find(call => call.sql.includes('consent_document link')).sql.includes('NOT EXISTS'));
    assert.equal(plans.data.activePlan.consent.patient_signature, 'unchanged-signature');
    assert.ok(plans.data.activePlan.review_token);
    costView = false;
    const redacted = await planDao.getPlan({ ...body, page: 1 });
    assert.equal(redacted.data.activePlan.treatments[0].cost, undefined);
    assert.equal(redacted.data.activePlan.consent.plan_snapshot.treatments[0].cost, undefined);
    assert.equal(redacted.data.activePlan.consent_document.content_html_snapshot, undefined);
    assert.equal(redacted.data.activePlan.review_token, plans.data.activePlan.review_token, 'Review token computed from full server data despite cost redaction');
    costView = true;
    for (const dao of [documentDao.listPatientDocuments.bind(documentDao), prescriptionDao.list.bind(prescriptionDao), planDao.getPlan.bind(planDao)]) {
        calls = []; assert.equal((await dao({ ...body, page: 0 })).status, 400); assert.equal(calls.length, 0);
        assert.ok((await dao({ ...body, id_person: 'foreign', page: 1 })).status >= 400);
        allowed = false; calls = []; assert.ok((await dao({ ...body, page: 1 })).status >= 400); assert.equal(calls.length, 0); allowed = true;
    }
    calls = [];
    assert.equal((await documentDao.createDocument({ ...body, page: 0 })).status, 400);
    assert.equal((await documentDao.updateStatus({ ...body, page: 0 }, 'FIRMADO')).status, 400);
    assert.equal((await planDao.mutation({ ...body, page: 0 }, 'edit', () => {})).status, 400);
    assert.equal(calls.length, 0, 'Invalid refresh paging rejected before mutations');
    failRead = true;
    assert.equal((await documentDao.listPatientDocuments({ ...body, page: 1 })).status, 500); failRead = false;
    const concurrent = await Promise.all(Array.from({ length: 5 }, (_, index) => documentDao.listPatientDocuments({ ...body, id_business: 'tenant-' + index, page: index + 1 })));
    concurrent.forEach((result, index) => { assert.equal(result.data.items.length, 10); assert.ok(result.data.items.every(row => row.id_business === 'tenant-' + index)); });
    for (const users of [1, 3, 5, 10]) {
        const mixed = await Promise.all(Array.from({ length: users }, async (_unused, index) => {
            const tenantBody = { ...body, id_business: 'mixed-' + index, page: 1 };
            return Promise.all([documentDao.listPatientDocuments(tenantBody), prescriptionDao.list(tenantBody), planDao.getPlan(tenantBody)]);
        }));
        mixed.forEach(([documents, prescriptions, plans], index) => {
            assert.equal(documents.data.items.length, 10); assert.equal(prescriptions.data.items.length, 10); assert.equal(plans.data.history.length, 5);
            assert.ok(documents.data.items.every(row => row.id_business === 'mixed-' + index));
            assert.ok(prescriptions.data.items.every(row => row.id_business === 'mixed-' + index));
            assert.equal(plans.data.patient.id_business, 'mixed-' + index);
        });
    }
    const dashboardDao = require('../../src/Dao/mysql/businessDashboard.dao');
    for (const mode of ['own', 'business']) await dashboardDao.firstVisitRetentionSummary({ _id_business: 'tenant', _from: '2026-10-01 00:00:00', _to: '2026-10-19 23:59:59', _doctor_profile: 'doctor' }, { scope: { mode } });
    const httpChecks = process.argv.includes('--http') ? await checkHttp() : 0;
    const result = { result: 'PASS', fixtureDocuments: 250, pageDocuments: 10, fixturePlans: 17, historyPagePlans: 5, activePlanPreserved: true,
        legacyDocumentBytes: Buffer.byteLength(JSON.stringify(legacy.data)), pagedDocumentBytes: Buffer.byteLength(JSON.stringify(paged.data)),
        fiveConcurrentTenants: 'PASS', mixedSimulatedUserBatches: [1, 3, 5, 10], validationFiltersOwnershipRevocationContentAndFailures: 'PASS', httpChecks, mysqlExecuted: false };
    if (process.argv.includes('--record')) {
        const output = path.resolve(__dirname, '../../../docs/platform-operations/evidence/PO14');
        fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'list-paging-results.json'), JSON.stringify(result, null, 2) + '\n');
        fs.writeFileSync(path.join(output, 'query-templates.json'), JSON.stringify([...queryTemplates.values()], null, 2) + '\n');
    }
    console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

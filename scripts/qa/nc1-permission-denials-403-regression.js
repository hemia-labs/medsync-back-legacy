'use strict';
// NC1 P2 (STG-UX4-ARCH1 §4.3 / review §8): a permission denial with a valid session is 403, never 401.
// The client treats 401 as a lost session (it clears it and reloads to /inicio), so answering 401 to a
// signed-in user who merely lacks a permission throws them out and discards what they were capturing.
// Contract:
//   - valid session without permission (or without business context): 403, nothing read or written;
//   - missing / expired / invalid authentication (Token.Auth): 401 with its AUTH_* code, unchanged;
//   - missing or foreign patient: 404 PATIENT_NOT_FOUND; archived patient on writes: 409 PATIENT_ARCHIVED;
//   - own vs. complete prescription scope and business isolation unchanged.
// Real document and prescription DAOs and the real Token.Auth middleware; simulated database, synthetic
// rows only. No network, no real database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

const dbPath = require.resolve('../../src/db/Sequelize.connection');
const people = {
    'qa-active': { id_person: 'qa-active', id_business: 'qa-clinic', name: 'Activo', surname: 'QA', active: 1 },
    'qa-archived': { id_person: 'qa-archived', id_business: 'qa-clinic', name: 'Archivado', surname: 'QA', active: 0 }
};
let queries = [], transactions = 0, rollbacks = 0, commits = 0;
const db = {
    async transaction() {
        transactions++;
        return { finished: false, async commit() { commits++; this.finished = true; }, async rollback() { rollbacks++; this.finished = true; } };
    },
    async query(sql, options = {}) {
        queries.push(sql);
        if (/FROM person\b/.test(sql) && /:_id_person/.test(sql) && !/FOR UPDATE|FOR SHARE/.test(sql)) {
            const r = options.replacements || {};
            const row = people[r._id_person];
            if (!row || row.id_business !== r._id_business) return [];
            if (/AND active = 1/.test(sql) && row.active !== 1) return [];
            return [{ ...row }];
        }
        if (/COUNT\(/i.test(sql)) return [{ total: 0 }];
        return [];
    }
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
const documents = require('../../src/Dao/mysql/document.dao');
const prescriptions = require('../../src/Dao/mysql/prescription.dao');

// Permission switches per test. Business isolation stays in the simulated queries above.
let allowed = new Set();
documents.hasPermission = async (_login, permission) => allowed.has('doc:' + permission);
prescriptions.hasPermission = async (_login, permission) => allowed.has('rx:' + permission);
const realViewAccess = prescriptions.getViewAccess;
let viewAccess = { canViewAll: false, canViewOwn: false };
prescriptions.getViewAccess = async () => ({ ...viewAccess });

const results = [];
const reset = () => { queries = []; transactions = 0; rollbacks = 0; commits = 0; allowed = new Set(); viewAccess = { canViewAll: false, canViewOwn: false }; };
const test = async (name, fn) => { reset(); await fn(); results.push(name); console.log('PASS ' + name); };
const body = (extra = {}) => ({ id_login: 'qa-doctor', id_business: 'qa-clinic', ...extra });
// FOR UPDATE row locks are reads; a write starts with the statement keyword.
const writes = () => queries.filter(sql => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql));
const denied = (response, label, code = 'PERMISSION_DENIED') => {
    assert.notEqual(response.status, 401, `${label}: a 401 ends a valid client session`);
    assert.equal(response.status, 403, `${label}: expected 403`);
    assert.equal(response.data && response.data.code, code, `${label}: stable code`);
    assert.ok(!/^AUTH_/.test(response.data.code), `${label}: never an authentication code`);
};

(async () => {
    await test('prescription list without view permission is 403 and reads nothing', async () => {
        for (const extra of [{}, { id_person: 'qa-active' }]) {
            reset();
            denied(await prescriptions.list(body(extra)), 'prescription list');
            assert.equal(queries.length, 0, 'No patient or prescription row is read');
        }
    });

    await test('prescription by id: no permission and other-doctor (own scope) are 403 without reading items', async () => {
        const rx = { id_prescription: 'qa-rx', id_business: 'qa-clinic', issuer_doctor_id: 'qa-other', created_by: 'qa-other', status: 'issued' };
        let itemReads = 0;
        const original = { getPrescription: prescriptions.getPrescription, getItems: prescriptions.getItems };
        prescriptions.getPrescription = async (id, business) => (id === 'qa-rx' && business === 'qa-clinic' ? { ...rx } : null);
        prescriptions.getItems = async () => { itemReads++; return []; };
        try {
            denied(await prescriptions.getById(body({ id_prescription: 'qa-rx' })), 'getById without permission');
            viewAccess = { canViewAll: false, canViewOwn: true };
            denied(await prescriptions.getById(body({ id_prescription: 'qa-rx' })), 'getById of another doctor with own scope');
            assert.equal(itemReads, 0, 'Denied prescriptions never load their items');
            assert.equal((await prescriptions.getById(body({ id_prescription: 'qa-rx', id_business: 'qa-other-clinic' }))).status, 404, 'Foreign business stays 404');
            viewAccess = { canViewAll: true, canViewOwn: true };
            assert.equal((await prescriptions.getById(body({ id_prescription: 'qa-rx' }))).status, 200, 'Complete scope still reads it');
            viewAccess = { canViewAll: false, canViewOwn: true };
            assert.equal((await prescriptions.getById(body({ id_prescription: 'qa-rx', id_login: 'qa-other' }))).status, 200, 'Own scope still reads own prescription');
        } finally { Object.assign(prescriptions, original); }
    });

    await test('prescription list keeps own/complete scope and 404 for missing or foreign patient', async () => {
        viewAccess = { canViewAll: false, canViewOwn: true };
        assert.equal((await prescriptions.list(body({ id_person: 'qa-active' }))).status, 200);
        assert.ok(queries.some(sql => /issuer_doctor_id|created_by/.test(sql)), 'Own scope still filters by the signed-in doctor');
        for (const extra of [{ id_person: 'qa-missing' }, { id_person: 'qa-active', id_business: 'qa-other-clinic' }]) {
            const response = await prescriptions.list(body(extra));
            assert.equal(response.status, 404);
            assert.equal(response.data.code, 'PATIENT_NOT_FOUND');
        }
        viewAccess = { canViewAll: true, canViewOwn: true };
        assert.equal((await prescriptions.list(body({ id_person: 'qa-archived' }))).status, 200, 'Archived patients stay readable');
    });

    await test('saving a prescription without permission is 403, rolled back, nothing read or written', async () => {
        for (const prescription of [{ id_person: 'qa-active', items: [] }, { id_person: 'qa-active', id_prescription: 'qa-rx', items: [] }]) {
            reset();
            denied(await prescriptions.save(body({ prescription })), 'prescription save');
            assert.equal(rollbacks, 1);
            assert.equal(queries.length, 0, 'The patient is not even looked up');
        }
        allowed = new Set(['rx:prescriptions.create']);
        const archived = await prescriptions.save(body({ prescription: { id_person: 'qa-archived', items: [] } }));
        assert.equal(archived.status, 409);
        assert.equal(archived.data.code, 'PATIENT_ARCHIVED');
        const missing = await prescriptions.save(body({ prescription: { id_person: 'qa-missing', items: [] } }));
        assert.equal(missing.status, 404);
        assert.equal(writes().length, 0);
    });

    await test('issue, cancel and delete draft without permission are 403 with no writes', async () => {
        denied(await prescriptions.issue(body({ id_prescription: 'qa-rx' })), 'issue');
        denied(await prescriptions.cancel(body({ id_prescription: 'qa-rx', reason: 'QA' })), 'cancel');
        denied(await prescriptions.deleteDraft(body({ id_prescription: 'qa-rx' })), 'deleteDraft');
        denied(await prescriptions.saveConfig(body({ config: {} })), 'saveConfig');
        assert.equal(queries.length, 0);
        assert.equal(commits, 0);
    });

    await test('issuing as another doctor, as a non-doctor or for an inactive business is 403 with no writes', async () => {
        const stubs = {
            getPrescription: async () => ({ id_prescription: 'qa-rx', id_business: 'qa-clinic', issuer_doctor_id: 'qa-other', status: 'draft' }),
            getItems: async () => [], validateItemsForIssue: () => ({ isValid: true }),
            getRawConfig: async () => ({}), validateConfigForIssue: () => ({ isValid: true }),
            getBusiness: async () => ({ active: 1, status: 'active' })
        };
        const original = {};
        for (const key of [...Object.keys(stubs), 'getDoctor']) original[key] = prescriptions[key];
        Object.assign(prescriptions, stubs);
        try {
            prescriptions.getDoctor = async login => ({ id_login: login });
            allowed = new Set(['rx:prescriptions.issue']);
            denied(await prescriptions.issue(body({ id_prescription: 'qa-rx' })), 'issue with another issuer');
            prescriptions.getDoctor = async login => (login === 'qa-other' ? { id_login: login } : null);
            denied(await prescriptions.issue(body({ id_prescription: 'qa-rx' })), 'issue as non-doctor');
            prescriptions.getBusiness = async () => ({ active: 0, status: 'suspended' });
            denied(await prescriptions.issue(body({ id_prescription: 'qa-rx' })), 'issue for inactive business', 'BUSINESS_NOT_ACTIVE');
            assert.equal(writes().length, 0);
            assert.equal(commits, 0);
        } finally { Object.assign(prescriptions, original); }
    });

    await test('session without business context is 403, not 401', async () => {
        const noBusiness = { id_login: 'qa-admin', id_business: null };
        denied(await prescriptions.list({ ...noBusiness }), 'list without business', 'BUSINESS_CONTEXT_REQUIRED');
        denied(await prescriptions.save({ ...noBusiness, prescription: { id_person: 'qa-active' } }), 'save without business', 'BUSINESS_CONTEXT_REQUIRED');
        denied(await prescriptions.getConfig(null, null, 'qa-admin'), 'getConfig without business', 'BUSINESS_CONTEXT_REQUIRED');
        denied(await prescriptions.saveConfig({ ...noBusiness }), 'saveConfig without business', 'BUSINESS_CONTEXT_REQUIRED');
        assert.equal(queries.length, 0);
    });

    await test('documents: create, sign/cancel, audit and template without permission are 403 with no read or write', async () => {
        const create = await documents.createDocument(body({ id_person: 'qa-active', id_document_template: 'qa-template' }));
        denied(create, 'createDocument');
        assert.equal(transactions, 0, 'No transaction for a denied create');
        denied(await documents.updateStatus(body({ id_patient_document: 'qa-doc' }), 'FIRMADO', 'SIGNED', null), 'sign');
        denied(await documents.updateStatus(body({ id_patient_document: 'qa-doc' }), 'CANCELADO', 'CANCELLED', 'QA'), 'cancel');
        denied(await documents.auditAction(body({ id_patient_document: 'qa-doc', event_type: 'VIEWED' })), 'auditAction');
        denied(await documents.saveTemplate(body({ name: 'QA' })), 'saveTemplate');
        assert.equal(queries.length, 0, 'No document or patient row is read');
        const list = await documents.listPatientDocuments(body({ id_person: 'qa-active' }));
        assert.equal(list.status, 403, 'Document list keeps answering 403');
    });

    await test('documents: choosing another responsible doctor without permission is 403', async () => {
        const original = documents.getActor;
        documents.getActor = async () => ({ id_login: 'qa-doctor', rol: 'assistant' });
        try {
            const resolved = await documents.resolveDoctor(body({ responsible_doctor_user_id: 'qa-other' }));
            assert.ok(resolved && resolved.error, 'Another doctor is rejected');
            denied(resolved.error, 'resolveDoctor');
        } finally { documents.getActor = original; }
    });

    await test('documents keep 404 for missing/foreign and 409 for archived writes', async () => {
        allowed = new Set(['doc:documents.create', 'doc:documents.view']);
        assert.equal((await documents.createDocument(body({ id_person: 'qa-missing', id_document_template: 'qa-template' }))).status, 404);
        assert.equal((await documents.createDocument(body({ id_person: 'qa-active', id_business: 'qa-other-clinic', id_document_template: 'qa-template' }))).status, 404);
        const archived = await documents.createDocument(body({ id_person: 'qa-archived', id_document_template: 'qa-template' }));
        assert.equal(archived.status, 409);
        assert.equal(archived.data.code, 'PATIENT_ARCHIVED');
        assert.equal(transactions, 0);
    });

    await test('no permission denial in the document or prescription DAOs answers 401', async () => {
        for (const file of ['document.dao.js', 'prescription.dao.js']) {
            const source = fs.readFileSync(nodePath.join(__dirname, '../../src/Dao/mysql', file), 'utf8');
            assert.ok(!/responseData\.unauthorized\(/.test(source), `${file} must not answer 401; authentication belongs to Token.Auth`);
        }
    });

    await test('authentication failures keep their 401 contract', async () => {
        const jwt = require('jsonwebtoken');
        const configjwt = require('../../src/config/jwt');
        const cookiePath = require.resolve('../../src/config/authCookie.config');
        const principalPath = require.resolve('../../src/auth/activePrincipal');
        const pendingPath = require.resolve('../../src/auth/pendingActivation');
        const authPath = require.resolve('../../src/auth/authenticate');
        let principal = null;
        require.cache[cookiePath] = { id: cookiePath, filename: cookiePath, loaded: true, exports: { getAuthCookieConfig: () => ({ isCookieAuthEnabled: false }) } };
        require.cache[principalPath] = { id: principalPath, filename: principalPath, loaded: true, exports: async () => principal };
        require.cache[pendingPath] = { id: pendingPath, filename: pendingPath, loaded: true, exports: { enforcePendingActivation: () => false } };
        delete require.cache[authPath];
        const Token = require('../../src/auth/authenticate');
        const run = token => new Promise(resolve => {
            const req = { method: 'GET', url: '/', headers: token ? { authorization: 'Bearer ' + token } : {}, cookies: {} };
            const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, send(payload) { resolve({ status: this.statusCode, payload }); } };
            Token.Auth(req, res, () => resolve({ status: 'next', req }));
        });
        const key = configjwt.key;
        const sign = (payload, options = {}) => jwt.sign(payload, key, { algorithm: 'HS256', ...options });
        const missing = await run(null);
        assert.equal(missing.status, 401); assert.equal(missing.payload.data.code, 'AUTH_ACCESS_INVALID');
        const invalid = await run(jwt.sign({ id_login: 'qa' }, 'not-the-key', { algorithm: 'HS256' }));
        assert.equal(invalid.status, 401); assert.equal(invalid.payload.data.code, 'AUTH_ACCESS_INVALID');
        const expired = await run(sign({ id_login: 'qa', exp: Math.floor(Date.now() / 1000) - 60 }));
        assert.equal(expired.status, 401); assert.equal(expired.payload.data.code, 'AUTH_ACCESS_EXPIRED');
        const revoked = await run(sign({ id_login: 'qa' }));
        assert.equal(revoked.status, 401); assert.equal(revoked.payload.data.code, 'AUTH_SESSION_INVALID');
        principal = { id_login: 'qa', id_business: 'qa-clinic' };
        const valid = await run(sign({ id_login: 'qa' }));
        assert.equal(valid.status, 'next', 'A valid session reaches the handler, where permission decides 403');
    });

    prescriptions.getViewAccess = realViewAccess;
    console.log(`PASS: ${results.length} NC1 permission-denial groups. Synthetic rows only; no database or network.`);
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// STG-UX4-ARCH1: opening an archived patient must not answer 401.
// In test, GET /api/document/patient/:id answered 401 «El paciente no pertenece al negocio activo.»
// for archived 000073; the client treats 401 as a lost session and reloads to /inicio, so the record
// (and «Restaurar paciente») could never be reached. Real document and prescription DAOs, simulated
// database with synthetic rows only. No network, no real database.
const assert = require('node:assert/strict');
const path = require.resolve('../../src/db/Sequelize.connection');
const people = {
    'qa-active': { id_person: 'qa-active', id_business: 'qa-clinic', name: 'Activo', surname: 'QA', active: 1 },
    'qa-archived': { id_person: 'qa-archived', id_business: 'qa-clinic', name: 'Archivado', surname: 'QA', active: 0 }
};
let personQueries = [], transactions = 0, rollbacks = 0;
const db = {
    async transaction() { transactions++; return { finished: false, async commit() { this.finished = true; }, async rollback() { rollbacks++; this.finished = true; } }; },
    async query(sql, options = {}) {
        if (/FROM person\b/.test(sql) && /:_id_person/.test(sql) && !/FOR UPDATE|FOR SHARE/.test(sql)) {
            const r = options.replacements || {};
            const row = people[r._id_person];
            personQueries.push(sql);
            if (!row || row.id_business !== r._id_business) return [];
            if (/AND active = 1/.test(sql) && row.active !== 1) return [];
            return [{ ...row }];
        }
        // Everything after the patient check: an empty clinic is enough to prove the request proceeds.
        if (/COUNT\(/i.test(sql)) return [{ total: 0 }];
        return [];
    }
};
require.cache[path] = { id: path, filename: path, loaded: true, exports: db };
const documents = require('../../src/Dao/mysql/document.dao');
const prescriptions = require('../../src/Dao/mysql/prescription.dao');
documents.hasPermission = async () => true;
prescriptions.hasPermission = async () => true;
prescriptions.getViewAccess = async () => ({ canViewAll: true, canViewOwn: true });

const results = [];
const test = async (name, fn) => { personQueries = []; transactions = 0; rollbacks = 0; await fn(); results.push(name); console.log('PASS ' + name); };
const body = (id_person, extra = {}) => ({ id_login: 'qa-doctor', id_business: 'qa-clinic', id_person, ...extra });

(async () => {
    await test('documents of an archived patient are readable (was 401)', async () => {
        const response = await documents.listPatientDocuments(body('qa-archived'));
        assert.notEqual(response.status, 401, 'A 401 here ends the client session and sends the user to /inicio');
        assert.equal(response.status, 200);
        assert.ok(personQueries.length && personQueries.every(sql => !/AND active = 1/.test(sql)), 'The read looks up archived patients too');
    });

    await test('active patient documents keep working', async () => {
        assert.equal((await documents.listPatientDocuments(body('qa-active'))).status, 200);
    });

    await test('unknown or foreign patient is 404, never 401', async () => {
        for (const response of [await documents.listPatientDocuments(body('qa-missing')), await documents.listPatientDocuments({ ...body('qa-active'), id_business: 'qa-other-clinic' })]) {
            assert.equal(response.status, 404);
            assert.equal(response.data.code, 'PATIENT_NOT_FOUND');
        }
    });

    await test('creating a document for an archived patient is 409 and writes nothing', async () => {
        const response = await documents.createDocument(body('qa-archived', { id_document_template: 'qa-template' }));
        assert.equal(response.status, 409);
        assert.equal(response.data.code, 'PATIENT_ARCHIVED');
        assert.equal(transactions, 0, 'No transaction is opened for an archived patient');
        assert.equal((await documents.createDocument(body('qa-missing', { id_document_template: 'qa-template' }))).status, 404);
    });

    await test('prescriptions of an archived patient are listable (was 401)', async () => {
        const response = await prescriptions.list(body('qa-archived'));
        assert.notEqual(response.status, 401);
        assert.equal(response.status, 200);
        assert.equal((await prescriptions.list(body('qa-missing'))).status, 404);
    });

    await test('saving a prescription for an archived patient is 409 and rolls back', async () => {
        const response = await prescriptions.save(body('qa-archived', { prescription: { id_person: 'qa-archived', issuer_doctor_id: 'qa-doctor', items: [] } }));
        assert.equal(response.status, 409);
        assert.equal(response.data.code, 'PATIENT_ARCHIVED');
        assert.equal(rollbacks, 1);
        const missing = await prescriptions.save(body('qa-missing', { prescription: { id_person: 'qa-missing', issuer_doctor_id: 'qa-doctor', items: [] } }));
        assert.equal(missing.status, 404);
    });

    await test('default patient lookups still exclude archived patients', async () => {
        assert.equal(await documents.getPatient('qa-archived', 'qa-clinic'), null);
        assert.equal(await prescriptions.getPatient('qa-archived', 'qa-clinic'), null);
        assert.equal((await documents.getPatient('qa-archived', 'qa-clinic', { includeArchived: true })).active, 0);
    });

    console.log(`PASS: ${results.length} STG-UX4-ARCH1 groups. Synthetic rows only; no database or network.`);
})().catch(error => { console.error(error); process.exitCode = 1; });

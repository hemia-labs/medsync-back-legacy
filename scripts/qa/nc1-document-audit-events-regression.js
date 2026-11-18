'use strict';
// Real DAO/controller and tenant binding; scripted SQL only, no database or deliveries.
const assert = require('node:assert/strict');
const dbPath = require.resolve('../../src/db/Sequelize.connection');
let queries, permission, failInsert;
const document = { id_patient_document: 'qa-doc', id_business: 'qa-clinic', active: 1, status: 'PENDIENTE_FIRMA' };
const db = { async query(sql, options = {}) {
    const r = options.replacements || {};
    queries.push({ sql, r });
    if (sql.includes('FROM patient_documents')) {
        assert.match(sql, /id_business/); assert.match(sql, /active = 1/);
        return r._id_patient_document === document.id_patient_document && r._id_business === document.id_business ? [document] : [];
    }
    if (sql.includes('INSERT INTO patient_document_events')) {
        if (failInsert) throw new Error('Synthetic audit storage failure');
        return [];
    }
    throw new Error('Unexpected SQL');
} };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
const dao = require('../../src/Dao/mysql/document.dao');
const controller = require('../../src/controller/mysql/document.controller');
dao.hasPermission = async (actor, code) => { assert.equal(actor, 'qa-actor'); assert.equal(code, 'documents.view'); return permission; };
const body = extra => ({ id_login: 'qa-actor', id_business: 'qa-clinic', id_patient_document: 'qa-doc', ...extra });
const reset = () => { queries = []; permission = true; failInsert = false; };
const events = () => queries.filter(q => q.sql.includes('INSERT INTO patient_document_events'));
const tests = [];
const test = async (name, fn) => { reset(); try { await fn(); console.log('PASS ' + name); } catch (error) { tests.push(name); console.error('FAIL ' + name + ': ' + error.message); } };
(async () => {
    for (const event of ['SIGNED', 'REFUSAL_REGISTERED']) await test('client cannot declare ' + event, async () => {
        const result = await dao.auditAction(body({ event_type: event }));
        assert.equal(result.status, 400); assert.equal(queries.length, 0, 'reject before any document read or audit insert');
        assert.equal(document.status, 'PENDIENTE_FIRMA');
    });
    await test('other clinical or malformed event names remain rejected', async () => {
        for (const event of ['REFUSAL_SUPERSEDED', 'SUPERSEDES_REFUSAL', 'SIGNATURE_CAPTURED', 'CONSENT_REPLACED', 'CANCELLED', 'signed', '', null, undefined, ['VIEWED']]) {
            assert.equal((await dao.auditAction(body({ event_type: event }))).status, 400);
        }
        assert.equal(queries.length, 0);
    });
    await test('VIEWED and PRINTED persist exactly one observation each', async () => {
        for (const event of ['VIEWED', 'PRINTED']) {
            reset(); const result = await dao.auditAction(body({ event_type: event, notes: 'QA observation' }));
            assert.equal(result.status, 200); assert.equal(events().length, 1);
            const r = events()[0].r;
            assert.equal(r._event_type, event); assert.equal(r._id_login, 'qa-actor'); assert.equal(r._id_business, 'qa-clinic');
            assert.equal(r._id_patient_document, 'qa-doc'); assert.equal(r._notes, 'QA observation');
            assert.equal(queries.filter(q => /^\s*(UPDATE|DELETE)/.test(q.sql)).length, 0);
        }
    });
    await test('view permission denial remains 403 without document reads', async () => {
        permission = false;
        const result = await dao.auditAction(body({ event_type: 'VIEWED' }));
        assert.equal(result.status, 403); assert.equal(result.data.code, 'PERMISSION_DENIED'); assert.equal(queries.length, 0);
    });
    await test('missing or foreign document cannot receive audit events', async () => {
        for (const extra of [{ id_patient_document: 'qa-missing' }, { id_business: 'qa-other' }]) {
            assert.equal((await dao.auditAction(body({ event_type: 'PRINTED', ...extra }))).status, 400);
        }
        assert.equal(events().length, 0);
    });
    await test('controller overrides supplied actor and business with session context', async () => {
        let result;
        await controller.AuditAction({ tokenDecode: { id_login: 'qa-actor', id_business: 'qa-clinic', rol: 'doctor' },
            body: body({ event_type: 'VIEWED', id_login: 'forged-actor', id_business: 'forged-clinic' }) },
            { status(code) { this.code = code; return this; }, send(value) { result = value; } });
        assert.equal(result.status, 200); assert.equal(events()[0].r._id_login, 'qa-actor'); assert.equal(events()[0].r._id_business, 'qa-clinic');
    });
    await test('audit insert failure never reports success', async () => {
        failInsert = true;
        const result = await dao.auditAction(body({ event_type: 'VIEWED' }));
        assert.notEqual(result.status, 200); assert.equal(document.status, 'PENDIENTE_FIRMA');
    });
    console.log(tests.length ? 'FAIL: ' + tests.length + ' groups' : 'PASS: 8 groups; no network, database or clinical mutation');
    if (tests.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });

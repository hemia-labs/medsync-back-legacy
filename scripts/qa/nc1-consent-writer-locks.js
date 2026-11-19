// Execute real writer entry points up to their document lock; synthetic adapter, no DB/network.
const assert = require('node:assert/strict');
// Isolated synthetic token configuration; never load a shared environment secret.
process.env.APP_ENV = 'test';
process.env.SIGNATURE_LINK_TOKEN_SECRET = 'qa-only-consent-writer-locks-secret';
const path = require.resolve('../../src/db/Sequelize.connection');
let locks = [], documentLockSeen = false;
const recordDocument = () => { assert.deepEqual(locks, ['patient'], 'Patient mutex must precede document/request locks'); documentLockSeen = true; };
const connection = {
    async transaction() { return { async commit() {}, async rollback() {} }; },
    async query(sql) {
        if (/FROM person WHERE/.test(sql) && /FOR UPDATE/.test(sql)) { locks.push('patient'); return [{ id_person: 'patient', active: 1 }]; }
        if (/SELECT id_person FROM (patient_documents|document_signature_requests)/.test(sql)) return [{ id_person: 'patient' }];
        if (/SELECT id_person, origin/.test(sql)) return [{ id_person: 'patient', document_type: 'SENSITIVE_DATA_CONSENT' }];
        if (/FROM (patient_documents pd|document_signature_requests dsr)/.test(sql) && /FOR UPDATE/.test(sql)) { recordDocument(); return []; }
        throw Error('Unexpected writer SQL: ' + sql.slice(0, 70));
    }
};
require.cache[path] = { id: path, filename: path, loaded: true, exports: connection };
const document = require('../../src/Dao/mysql/document.dao');
const publicSignature = require('../../src/Dao/mysql/publicDocumentSignature.dao');
const requests = require('../../src/Dao/mysql/documentSignatureRequest.dao');
const body = { id_business: 'business', id_login: 'doctor', id_person: 'patient', id_patient_document: 'document' };
document.hasPermission = async () => true;
document.getPatient = async () => ({ id_person: 'patient', active: 1 });
document.getTemplateVersion = async () => { recordDocument(); return null; };
requests.assertRequestPermission = async () => null;
const request = { id_person: 'patient', id_business: 'business', id_patient_document: 'document', document_type: 'SENSITIVE_DATA_CONSENT', status: 'pending', expires_at: new Date(Date.now() + 60000) };
publicSignature.getRequestByHash = async () => request;
publicSignature.getDocument = async () => { recordDocument(); return null; };
publicSignature.getPatient = async () => null;
publicSignature.getDocumentSignatures = async () => [];
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=';
(async () => {
    const cases = [
        ['create', () => document.createDocument(body)],
        ['local sign', () => document.updateStatus(body, 'FIRMADO', 'SIGNED', 'QA')],
        ['refusal', () => document.updateStatus(body, 'NO_FIRMADO_POR_NEGATIVA', 'REFUSAL_REGISTERED', 'QA')],
        ['cancel', () => document.updateStatus(body, 'CANCELADO', 'CANCELLED', 'QA')],
        ['signature request create/list helper', () => requests.getDocumentForRequest('business', 'document', {}, true)],
        ['signature request revoke', () => requests.revoke({ ...body, id_document_signature_request: 'request' })],
        ['remote open', () => publicSignature.openByToken('a'.repeat(43))],
        ['remote sign', () => publicSignature.signByToken('a'.repeat(43), { accepted_electronic_signature: true, signature_image: png })]
    ];
    for (const [name, run] of cases) { locks = []; documentLockSeen = false; await run();
        assert.deepEqual(locks, ['patient'], name); assert.equal(documentLockSeen, true, name); console.log('PASS patient first: ' + name); }
})().catch(error => { console.error(error); process.exitCode = 1; });

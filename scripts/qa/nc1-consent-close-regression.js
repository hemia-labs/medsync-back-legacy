const assert = require('node:assert/strict');
const connection = require.resolve('../../src/db/Sequelize.connection');
let writes = 0, locked = false, beforeLock, consent, invertedLocks = 0;
const db = { async transaction() { return { async commit() {}, async rollback() {} }; },
    async query(sql) {
        if(sql.startsWith('SELECT logo_url FROM business')) return [{logo_url:null}]; if (sql.startsWith('UPDATE clinical_histories')) { writes++; return []; } throw Error('Unexpected SQL in close harness'); } };
require.cache[connection] = { id: connection, filename: connection, loaded: true, exports: db };
const dao = require('../../src/Dao/mysql/clinicalHistory.dao');
const allergy = require('../../src/Dao/mysql/patientAllergy.dao');
const profile = { id_login: 'doctor', id_doctor_professional_profile: 'profile', professional_profile_active: 1,
    professional_name: 'QA', professional_license: 'QA', rol: 'doctor' };
dao.hasPermission = async () => true;
dao.getDoctorProfile = async (business, actor, tx) => { if(tx && !locked) invertedLocks++; return profile; };
dao.getHistoryById = async () => ({ id_clinical_history: 'history', patient_id: 'patient', status: 'DRAFT', revision: 1,
    clinical_snapshot_json: {}, template_snapshot_json: { sections: [] } });
dao.getPatient = async () => ({ id_person: 'patient' });
dao.lockDraft = async () => { locked = true; if(beforeLock) beforeLock(); return true; };
dao.getSensitiveConsent = async () => consent;
dao.getById = async () => ({ status: 200, data: {} });
dao.addEvent = async () => {};
dao.validateRequiredFieldsFromTemplate = () => ({ ok: true });
allergy.getCurrent = async () => ({ review_status: 'NONE_KNOWN', revision: 1 });
const token = 'a'.repeat(64);
const body = () => ({ id_business: 'business', id_login: 'doctor', id_clinical_history: 'history', expected_revision: 1,
    expected_consent_token: token, expected_consent_document_id: 'signed', expected_consent_status: 'FIRMADO' });
const reset = () => { writes = 0; locked = false; beforeLock = null; const document = { id_patient_document: 'signed', status: 'FIRMADO' };
    consent = { token, status: 'FIRMADO', document, signedDocument: document, refusalDocument: null }; };
(async () => {
    for (const change of [b => { b.expected_consent_token = ''; }, b => { b.expected_consent_token = 'b'.repeat(64); },
        b => { b.expected_consent_document_id = 'other'; }, b => { b.expected_consent_status = 'NO_FIRMADO_POR_NEGATIVA'; }]) {
        reset(); const request = body(); change(request); const response = await dao.finalize(request);
        assert.equal(response.status, 409); assert.equal(response.data.code, 'CONSENT_REVIEW_CHANGED'); assert.equal(writes, 0);
    }
    console.log('PASS token, id and status checked before any history write');
    reset(); beforeLock = () => { consent.token = 'b'.repeat(64); };
    assert.equal((await dao.finalize(body())).status, 409); assert.equal(writes, 0);
    console.log('PASS changed clinical set under same effective id/status is rejected after patient lock');
    reset(); assert.equal((await dao.finalize(body())).status, 200); assert.equal(writes, 2);
    reset(); const legacy = body(); delete legacy.expected_consent_token; delete legacy.expected_consent_document_id; delete legacy.expected_consent_status;
    assert.equal((await dao.finalize(legacy)).status, 200); assert.equal(writes, 2);
    assert.equal(invertedLocks, 0, 'Profile cannot lock before patient');
    console.log('PASS matching review and explicit compatibility for older clients');
})().catch(error => { console.error(error); process.exitCode = 1; });

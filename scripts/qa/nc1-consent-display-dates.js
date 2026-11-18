'use strict';
// Service response contract, isolated: no env loader, MySQL or network.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const domain = require('../../src/domain/sensitiveConsent');
const stub = (file, exports) => {
    const id = require.resolve(file);
    require.cache[id] = { id, filename: id, loaded: true, exports };
};
const shared = { id_business: 'business-qa', id_person: 'patient-qa', document_type: domain.TYPE, active: 1,
    title: 'Documento QA', created_at: '2026-11-18T01:40:00.000000', responsible_doctor_user_id: 'doctor-qa',
    responsible_doctor_profile_id: 'profile-qa', doctor_name_snapshot: 'Doctor QA' };
const documents = [
    { ...shared, id_patient_document: 'refusal-qa', status: domain.REFUSAL, signed_at: null, refusal_reason: 'Negativa QA' },
    { ...shared, id_patient_document: 'signed-qa', status: 'FIRMADO', signed_at: '2026-11-18T01:51:32.123456' }
];
const events = [{ id_patient_document_event: 'event-refusal-qa', id_patient_document: 'refusal-qa', id_business: 'business-qa',
    event_type: 'REFUSAL_REGISTERED', notes: 'Negativa QA', created_at: '2026-11-18T01:44:37.000000', created_by: 'doctor-qa' }];
const profile = { id_doctor_professional_profile: 'profile-qa', id_login: 'doctor-qa', professional_name: 'Doctor QA',
    professional_license: 'QA000', is_active: 1, can_sign_documents: 1, role: 'doctor' };
const db = {
    async transaction() { return { async commit() { this.finished = 'commit'; }, async rollback() { this.finished = 'rollback'; } }; },
    async query(sql) {
        if (sql.includes('FROM person WHERE')) return [{ id_person: 'patient-qa', active: 1 }];
        if (sql.includes('FROM patient_documents WHERE')) return documents;
        if (sql.includes('FROM patient_document_events e')) return events;
        if (sql.includes('FROM doctor_professional_profile p')) return [profile];
        throw new Error('Unexpected SQL in isolated date projection test');
    }
};
stub('../../src/db/Sequelize.connection', db);
stub('../../src/util/effectivePermissions', { hasPermission: async () => true });
const service = require('../../src/services/documentSignature/sensitiveConsent.service');
const actor = { id_person: 'patient-qa', id_business: 'business-qa', id_login: 'doctor-qa' };
const localDate = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));

test('review exposes UTC instants and keeps raw evidence/token unchanged', async () => {
    const before = JSON.stringify({ documents, events });
    const state = domain.resolve(documents, events);
    const response = await service.review(actor);
    assert.equal(response.status, 200);
    const refusal = response.data.documents.find(row => row.id_patient_document === 'refusal-qa');
    const signed = response.data.documents.find(row => row.id_patient_document === 'signed-qa');
    assert.equal(refusal.refusal_at, '2026-11-18T01:44:37.000000Z');
    assert.equal(refusal.signed_at, null);
    assert.equal(signed.refusal_at, null);
    assert.equal(signed.created_at, '2026-11-18T01:40:00.000000Z');
    assert.equal(signed.signed_at, '2026-11-18T01:51:32.123456Z');
    assert.equal(localDate(signed.signed_at), '17/11/2026, 19:51:32');
    assert.equal(response.data.consent_status, domain.REFUSAL);
    assert.equal(response.data.candidates[0].can_authorize, true);
    assert.equal(response.data.consent_token, state.token);
    assert.equal(JSON.stringify({ documents, events }), before);
});

test('existing substitution remains effective; only visible event date receives zone', async () => {
    const payload = domain.pairPayload(documents[0], documents[1], events, 'doctor-qa', 'profile-qa',
        'request-qa', 'Revisión sintética del consentimiento.', 'Doctor QA');
    for (const [id, type] of [['refusal-qa', 'REFUSAL_SUPERSEDED'], ['signed-qa', 'SUPERSEDES_REFUSAL']]) {
        events.push({ id_patient_document_event: type + '-qa', id_patient_document: id, id_business: 'business-qa',
            event_type: type, notes: JSON.stringify(payload), created_at: '2026-11-18T01:55:00.000000', created_by: 'doctor-qa' });
    }
    const before = JSON.stringify({ documents, events });
    const state = domain.resolve(documents, events);
    assert.equal(state.status, 'FIRMADO');
    const response = await service.review(actor);
    assert.equal(response.status, 200);
    assert.equal(response.data.consent_status, 'FIRMADO');
    assert.equal(response.data.consent_token, state.token);
    assert.deepEqual(response.data.pairs[0], { ...state.pairs[0], created_at: '2026-11-18T01:55:00.000000Z' });
    assert.equal(response.data.pairs[0].t, payload.t);
    assert.equal(response.data.pairs[0].u, payload.u);
    assert.equal(response.data.pairs[0].f, payload.f);
    assert.equal(localDate(response.data.pairs[0].created_at), '17/11/2026, 19:55:00');
    assert.equal(JSON.stringify({ documents, events }), before);
});

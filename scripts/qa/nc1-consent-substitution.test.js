const { test } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../../src/domain/sensitiveConsent');

function fixture() {
    const common = { document_type: d.TYPE, id_business: 'clinic', id_person: 'patient', active: 1,
        responsible_doctor_user_id: 'doctor', responsible_doctor_profile_id: 'profile', created_at: '2026-11-17T10:00:00.000000' };
    const refusal = { ...common, id_patient_document: 'refusal', status: d.REFUSAL, refusal_reason: 'Motivo anterior', signed_at: null };
    // Created earlier but signed later: chronology is signed_at, never document.created_at.
    const signed = { ...common, id_patient_document: 'signed', status: 'FIRMADO', signed_at: '2026-11-17T12:00:00.000000' };
    const event = { id_patient_document_event: 'event1', id_patient_document: 'refusal', id_business: 'clinic',
        event_type: 'REFUSAL_REGISTERED', created_at: '2026-11-17T11:00:00.000000', notes: 'Motivo anterior', created_by: 'doctor' };
    return { documents: [refusal, signed], events: [event], refusal, signed };
}
function pair(f) {
    const payload = d.pairPayload(f.refusal, f.signed, f.events, 'doctor', 'profile', 'request1', 'Consentimiento posterior revisado.');
    const common = { id_business: 'clinic', notes: JSON.stringify(payload), created_at: '2026-11-17T13:00:00.000000', created_by: 'doctor' };
    f.events.push({ ...common, id_patient_document_event: 'event2', id_patient_document: 'refusal', event_type: 'REFUSAL_SUPERSEDED' },
        { ...common, id_patient_document_event: 'event3', id_patient_document: 'signed', event_type: 'SUPERSEDES_REFUSAL' });
}
const resolve = f => d.resolve(f.documents, f.events);

test('refusal wins until explicit matching pair; neither document changes', () => {
    const f = fixture(), before = structuredClone(f.documents);
    assert.equal(resolve(f).status, d.REFUSAL); assert.equal(d.eligible(f.refusal, f.signed, f.events), true);
    pair(f); const state = resolve(f);
    assert.equal(state.status, 'FIRMADO'); assert.equal(state.pairs[0].effective, true);
    assert.deepEqual(f.documents, before);
});
test('strict signing chronology, missing evidence and cross scope are ineligible', () => {
    for (const change of [f => { f.signed.signed_at = f.events[0].created_at; }, f => { f.signed.signed_at = '2026-11-17T09:00:00'; },
        f => { f.events = []; }, f => { f.signed.id_business = 'other'; }, f => { f.signed.id_person = 'other'; },
        f => { f.signed.document_type = 'OTHER'; }, f => { f.signed.active = 0; }]) {
        const f = fixture(); change(f); assert.equal(d.eligible(f.refusal, f.signed, f.events), false);
    }
});
test('missing, corrupt, unmatched or duplicate events never suppress a refusal', () => {
    for (const change of [f => f.events.pop(), f => { f.events[1].notes = '{invalid'; },
        f => { f.events[2].created_by = 'assistant'; }, f => { f.events[2].id_business = 'other'; },
        f => { f.events[2].notes = f.events[2].notes.replace('request1', 'request2'); },
        f => f.events.push({ ...f.events[1], id_patient_document_event: 'duplicate' }),
        f => { f.signed.responsible_doctor_user_id = 'other'; }]) {
        const f = fixture(); pair(f); change(f); assert.equal(resolve(f).status, d.REFUSAL);
    }
});
test('cancelled or inactive signed consent restores refusal; a newer authorization can replace it', () => {
    for (const change of [f => { f.signed.status = 'CANCELADO'; }, f => { f.signed.active = 0; }]) {
        const f = fixture(); pair(f); change(f); assert.equal(resolve(f).status, d.REFUSAL);
        const next = { ...f.signed, active: 1, status: 'FIRMADO', id_patient_document: 'signed2', signed_at: '2026-11-17T14:00:00.000000' };
        f.documents.push(next);
        const payload = d.pairPayload(f.refusal, next, f.events, 'doctor', 'profile', 'request2', 'Segundo firmado válido revisado.');
        f.events.push(...f.events.slice(1).map((e, i) => ({ ...e, id_patient_document_event: 'next' + i,
            id_patient_document: i ? 'signed2' : 'refusal', notes: JSON.stringify(payload), created_at: '2026-11-17T15:00:00.000000' })));
        assert.equal(resolve(f).document.id_patient_document, 'signed2');
    }
});
test('new refusal even at the same second invalidates the old pair', () => {
    const f = fixture(); pair(f); const token = resolve(f).token;
    f.events.push({ ...f.events[0], id_patient_document_event: 'event0' });
    assert.equal(resolve(f).status, d.REFUSAL); assert.notEqual(resolve(f).token, token);
});
test('other refusals remain effective; historical documents and links remain unchanged', () => {
    const f = fixture(); pair(f);
    f.documents.push({ ...f.refusal, id_patient_document: 'refusal2' });
    assert.equal(resolve(f).document.id_patient_document, 'refusal2');
    assert.equal(f.refusal.status, d.REFUSAL);
});
test('token ignores observational audit and order, detects any clinical set change', () => {
    const f = fixture(); const token = resolve(f).token;
    f.events.push({ ...f.events[0], id_patient_document_event: 'view', event_type: 'VIEWED' });
    f.documents.reverse(); f.events.reverse(); assert.equal(resolve(f).token, token);
    f.signed.responsible_doctor_user_id = 'other'; assert.notEqual(resolve(f).token, token);
});
test('legacy notes and forged root fields are never interpreted as substitution', () => {
    const f = fixture(); pair(f);
    const p = JSON.parse(f.events[1].notes); p.role = 'admin';
    f.events[1].notes = f.events[2].notes = JSON.stringify(p);
    assert.equal(resolve(f).status, d.REFUSAL);
});

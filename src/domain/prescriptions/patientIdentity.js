'use strict';

function snapshotPatient(row) {
    return { version: 1, name: row.patient_name ?? null, birthday: row.patient_birthday ?? null, age: row.patient_age ?? null };
}

function withPatientIdentity(row) {
    if (!row) return row;
    let template = row.template_snapshot;
    if (typeof template === 'string') {
        try { template = JSON.parse(template); } catch (_) { template = null; }
    }
    const identity = template && template.patient_identity;
    if (row.status !== 'draft' && identity && identity.version === 1) {
        return { ...row, patient_name: identity.name, patient_birthday: identity.birthday,
            patient_age: identity.age, patient_identity_source: 'issued_snapshot' };
    }
    // Never backfill a historical identity from today's patient record.
    return { ...row, patient_identity_source: row.status === 'draft' ? 'current_record' : 'legacy_current_record' };
}

module.exports = { snapshotPatient, withPatientIdentity };

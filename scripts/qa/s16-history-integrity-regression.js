const assert = require('node:assert/strict');
const clone = value => JSON.parse(JSON.stringify(value));
let row, beforeLock = null, afterCommit = null, writes = 0, signed = true, refused = false, archived = false;
const transactions = [];
const connectionPath = require.resolve('../../src/db/Sequelize.connection');
const db = {
    async transaction() {
        const tx = { staged: null, async rollback() { this.rolledBack = true; }, async commit() { if (this.staged) row = clone(this.staged); this.committed = true; if (afterCommit) { const callback = afterCommit; afterCommit = null; callback(); } } };
        transactions.push(tx); return tx;
    },
    async query(sql, options = {}) {
        const tx = options.transaction, values = options.replacements || {};
        if(sql.startsWith('SELECT * FROM person WHERE')) {assert.equal(values.business,'tenant');return [{id_person:'patient',name:'Synthetic',surname:'Patient'}];}
        if(sql.startsWith('SELECT * FROM patient_identity WHERE')) {assert.equal(values.business,'tenant');return [];}
        if (sql.includes('FROM person p')) return archived && sql.includes('p.active = 1') ? [] : [{ id_person: 'patient' }];
        if (sql.includes('FROM clinical_histories')) {
            if (sql.includes('FOR UPDATE')) {
                if (beforeLock) { const callback = beforeLock; beforeLock = null; callback(); }
                tx.staged = clone(row);
            }
            return [clone(tx && tx.staged || row)];
        }
        if (sql.startsWith('UPDATE clinical_histories')) {
            assert.ok(tx && tx.staged, 'Every mutation must hold the history lock');
            writes++;
            const target = tx.staged;
            if (sql.includes('revision = revision + 1')) target.revision++;
            if (values._clinical_snapshot_json) target.clinical_snapshot_json = values._clinical_snapshot_json;
            if (values._template_snapshot_json) target.template_snapshot_json = values._template_snapshot_json;
            if (values.snapshot) target.clinical_snapshot_json = values.snapshot;
            if (values.schema) target.template_snapshot_json = values.schema;
            if (values.responsible) target.responsible_snapshot_json = values.responsible;
            if (values.finalizer) target.finalizer_snapshot_json = values.finalizer;
            if (/SET\s+status/.test(sql)) target.status = values._status;
            if (values._finalized_by) target.finalized_by_user_id = values._finalized_by;
            if (values._doctor_user_id) target.doctor_responsible_user_id = values._doctor_user_id;
            if (values._doctor_profile_id) target.doctor_responsible_profile_id = values._doctor_profile_id;
            return [1];
        }
        throw Error(`Unexpected SQL: ${sql.slice(0, 90)}`);
    }
};
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: db };
const dao = require('../../src/Dao/mysql/clinicalHistory.dao');
const allergy = require('../../src/Dao/mysql/patientAllergy.dao');
const profile = id => ({ id_login: id, id_doctor_professional_profile: `${id}-profile`, professional_name: `Doctor ${id}`, professional_license: `${id}-license`, specialty: 'QA', professional_profile_active: 1, rol: 'doctor' });
const profiles = { responsible: profile('responsible'), finalizer: profile('finalizer') };
dao.hasPermission = async () => true;
const originalGetPatient = dao.getPatient.bind(dao);
dao.getBusiness = async () => ({ id_business: 'tenant' });
dao.getDoctorProfile = async (business, id) => profiles[id] ? clone(profiles[id]) : null;
dao.getConsentDocumentById = async () => null;
dao.getSensitiveConsent = async () => ({ status: signed ? 'FIRMADO' : 'PENDIENTE_FIRMA', signedDocument: signed ? { id_patient_document: 'consent' } : null, refusalDocument: refused ? { id_patient_document: 'refusal' } : null });
dao.addEvent = async () => {};
dao.validateRequiredFieldsFromTemplate = () => ({ ok: true });
allergy.lockPatient = async () => !archived;
allergy.getCurrent = async () => ({ review_status: 'NONE_KNOWN', revision: 1 });
const originalGetDoctor = dao.getDoctorForHistory.bind(dao);
dao.getDoctorForHistory = async (history, transaction) => history.status === 'DRAFT' ? clone(profiles.responsible) : originalGetDoctor(history, transaction);
const reset = () => {
    writes = 0; beforeLock = null; afterCommit = null; signed = true; refused = false; archived = false;
    row = { id_clinical_history: 'history', business_id: 'tenant', patient_id: 'patient', status: 'DRAFT', revision: 0,
        doctor_responsible_user_id: 'responsible', doctor_responsible_profile_id: 'responsible-profile',
        clinical_snapshot_json: JSON.stringify({ consultation: { reason: 'Original' } }), template_snapshot_json: JSON.stringify({ sections: [] }) };
};
const body = revision => ({ id_clinical_history: 'history', id_business: 'tenant', id_login: 'finalizer', expected_revision: revision,
    doctor_responsible_user_id: 'responsible', clinical_snapshot_json: { consultation: { reason: 'Local capture' } } });
(async () => {
    reset();
    assert.equal((await dao.updateDraft(body(undefined))).status, 409);
    assert.equal(writes, 0, 'Missing revision must never permit blind overwrites');
    let result = await dao.updateDraft(body(0));
    assert.equal(result.status, 200); assert.equal(result.data.history.revision, 1);
    assert.equal(result.data.history.clinical_snapshot_json.consultation.reason, 'Local capture');
    assert.equal((await dao.updateDraft(body(0))).status, 409);
    assert.equal(row.revision, 1);
    beforeLock = () => { row.revision = 2; row.clinical_snapshot_json = JSON.stringify({ consultation: { reason: 'Other capture' } }); };
    assert.equal((await dao.updateDraft(body(1))).status, 409);
    assert.equal(JSON.parse(row.clinical_snapshot_json).consultation.reason, 'Other capture');
    reset();
    afterCommit = () => { row.revision = 2; row.clinical_snapshot_json = JSON.stringify({ consultation: { reason: 'Later writer' } }); };
    result = await dao.updateDraft(body(0));
    assert.equal(result.data.history.revision, 1, 'Response must represent exactly our committed revision');
    assert.equal(result.data.history.clinical_snapshot_json.consultation.reason, 'Local capture');
    assert.equal((await dao.finalize(body(result.data.history.revision))).status, 409, 'Cannot finalize another writer after the save response');
    reset();
    beforeLock = () => { row.revision++; row.status = 'FINALIZED'; };
    assert.equal((await dao.cancel(body(0))).status, 409);
    assert.equal(row.status, 'FINALIZED'); assert.equal(writes, 0, 'Cancel cannot overwrite concurrent finalization');
    reset();
    beforeLock = () => { row.revision++; };
    assert.equal((await dao.finalize(body(0))).status, 409); assert.equal(writes, 0);
    reset();
    result = await dao.finalize(body(0));
    assert.equal(result.status, 200); assert.equal(row.status, 'FINALIZED'); assert.equal(row.revision, 1);
    assert.equal(result.data.doctor.professional_name, 'Doctor responsible');
    assert.equal(result.data.finalizer.professional_name, 'Doctor finalizer');
    assert.equal(result.data.history.finalized_by_user_id, 'finalizer');
    profiles.responsible.professional_name = 'Changed profile'; profiles.responsible.professional_profile_active = 0;
    assert.equal((await dao.getDoctorForHistory(row)).professional_name, 'Doctor responsible', 'Historical names survive profile changes/deactivation');
    const legacy = await dao.getDoctorForHistory({ ...row, responsible_snapshot_json: null });
    assert.equal(legacy.identity_source, 'LEGACY_UNVERIFIED'); assert.equal(legacy.professional_name, undefined);
    reset();
    assert.equal((await dao.finalize(body(0))).status, 400); assert.equal(row.status, 'DRAFT');
    profiles.responsible = profile('responsible');
    reset(); signed = false;
    assert.equal((await dao.finalize(body(0))).status, 400);
    assert.equal(row.revision, 0); assert.equal(row.responsible_snapshot_json, undefined, 'Failed consent validation rolls all changes back');
    reset(); signed = false; refused = true;
    result = await dao.finalize(body(0));
    assert.equal(row.status, 'INCOMPLETE'); assert.equal(result.data.finalizer.id_login, 'finalizer');
    assert.equal(result.data.history.finalized_by_user_id, undefined, 'A refusal closure must not pretend clinical finalization');
    reset(); archived = true;
    assert.equal(await originalGetPatient('patient', 'tenant'), null, 'Default patient lookup rejects archived mutation targets');
    assert.equal((await dao.getById(body(0))).status, 200, 'Archived history remains available for authorized reading');
    assert.equal((await dao.getLatestByPatient({ ...body(0), patient_id: 'patient' })).status, 200);
    assert.equal((await dao.listVersionsByPatient({ ...body(0), patient_id: 'patient' })).status, 200);
    assert.notEqual((await dao.updateDraft(body(0))).status, 200);
    assert.notEqual((await dao.finalize(body(0))).status, 200);
    assert.notEqual((await dao.cancel(body(0))).status, 200);
    assert.notEqual((await dao.createDraft({ ...body(0), patient_id: 'patient' })).status, 200);
    assert.equal(writes, 0, 'Archival preserves consultation without enabling clinical mutations');
    assert.ok(transactions.every(tx => tx.committed || tx.rolledBack), 'Every transaction is closed');
    console.log('PASS S16 history: optimistic update/finalize/cancel, races before lock and after commit, no stale overwrite, rollback, distinct immutable professional identities and honest legacy fallback. Real DAO; in-memory SQL adapter; no DB writes.');
})().catch(error => { console.error(error); process.exitCode = 1; });

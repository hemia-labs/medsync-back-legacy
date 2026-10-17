const assert = require('node:assert/strict');
const inject = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
let codes = new Set(), actor = { id_login: 'actor', id_doctor_professional_profile: 'doctor', professional_name: 'QA doctor' };
let queries = [], history = null, patientAvailable = true, commits = 0;
const doctors = [{ id_doctor_professional_profile: 'doctor', id_login: 'doctor-login', professional_name: 'QA doctor' }];
const db = {
    async transaction() { return { commit: async () => { commits++; }, rollback: async () => {} }; },
    async query(sql, options = {}) {
        queries.push({ sql, options });
        if(sql.includes('FROM login l LEFT JOIN doctor_professional_profile')) return actor ? [actor] : [];
        if(sql.includes('FROM doctor_professional_profile d JOIN login l')) return doctors;
        if(sql.includes('FROM clinical_histories')) return history ? [{ ...history }] : [];
        if(sql.startsWith('UPDATE clinical_histories')) history = { ...history, revision: history.revision + 1, clinical_snapshot_json: options.replacements.snapshot, doctor_responsible_profile_id: options.replacements.doctorProfile, doctor_responsible_user_id: options.replacements.doctorLogin };
        if(sql.startsWith('INSERT INTO clinical_histories')) history = { id_clinical_history: options.replacements.history, status: 'DRAFT', revision: 0, clinical_snapshot_json: options.replacements.snapshot, doctor_responsible_profile_id: options.replacements.doctorProfile, doctor_responsible_user_id: options.replacements.doctorLogin };
        return [];
    }
};
inject('../../src/db/Sequelize.connection', db);
inject('../../src/util/effectivePermissions', { rows: async () => [...codes].map(code => ({ code })), hasPermission: async (id, code) => codes.has(code) });
inject('../../src/Dao/mysql/licenseUsage.dao', { getBusinessPlan: async () => ({ plan: 'pro' }) });
inject('../../src/Dao/mysql/clinicalHistory.dao', {
    getPatient: async (id, business) => patientAvailable && business === 'business' ? { id_person: id, full_name: 'QA Patient', age: 30, birthday: '1996-01-01', telephone: 'private-omitted' } : null,
    addEvent: async () => {}, nextVersion: async () => 1,
    resolveTemplateSnapshot: async () => ({ templateVersionId: null, templateSnapshotJson: null })
});
inject('../../src/Dao/mysql/patientAllergy.dao', { lockPatient: async () => patientAvailable, getCurrent: async () => ({ review_status: 'UNKNOWN', revision: 1 }) });
const access = require('../../src/util/dashboardAccess');
const intake = require('../../src/Dao/mysql/clinicalIntake.dao');
const domain = require('../../src/domain/clinicalHistory/intake');
const body = { id_business: 'business', id_login: 'actor', patient_id: 'patient', doctor_responsible_profile_id: 'doctor' };

(async () => {
    assert.equal((await access.resolveDashboardAccess('business', 'actor')).error.status, 403);
    assert.equal((await access.resolveDashboardAccess('business', 'actor', { requireFamily: false })).scope.mode, 'own');
    codes = new Set(['dashboard.operations', 'dashboard.clinical']);
    let result = await access.resolveDashboardAccess('business', 'actor');
    assert.equal(result.scope.mode, 'own'); assert.equal(result.scope.doctorName, 'QA doctor');
    assert.deepEqual(result.families, { administrative: true, clinical: true, financial: false });
    assert.equal((await access.resolveDashboardAccess('business', 'actor', { scope: 'tenant' })).error.status, 403);
    codes.add('dashboard.scope.all'); result = await access.resolveDashboardAccess('business', 'actor', { scope: 'tenant' });
    assert.equal(result.scope.mode, 'tenant'); assert.equal(result.scope.doctorProfileId, null); assert.equal(result.administrativeTeam, true);
    actor = { id_login: 'reception' }; codes = new Set(['dashboard.operations', 'dashboard.clinical', 'dashboard.financial']);
    result = await access.resolveDashboardAccess('business', 'actor');
    assert.deepEqual(result.families, { administrative: true, clinical: false, financial: false }); assert.equal(result.administrativeTeam, false);
    assert.equal((await access.resolveDashboardAccess('business', 'actor', { scope: 'own' })).error.status, 403);
    codes.add('dashboard.scope.all'); assert.equal((await access.resolveDashboardAccess('business', 'actor')).families.financial, true);
    actor = null; assert.equal((await access.resolveDashboardAccess('foreign', 'actor')).error.status, 403);

    queries = []; codes = new Set(['px.all']);
    assert.equal((await intake.get(body)).status, 403); assert.equal(queries.length, 0);
    codes.add('clinical_history.intake');
    assert.equal((await intake.get({ ...body, id_business: 'foreign' })).status, 403);
    const original = { consultation: { reason: 'old', private_extra: 'SECRET' }, diagnosis: { initial_diagnosis: 'SECRET' }, therapeutic_plan: { initial_plan: 'SECRET' }, allergies_medications: { allergy_review_status: 'HAS_ALLERGIES', allergies: 'SECRET' }, custom: ['SECRET'] };
    history = { id_clinical_history: 'history', status: 'DRAFT', revision: 4, clinical_snapshot_json: JSON.stringify(original) };
    result = await intake.get(body); assert.equal(result.status, 200); assert.ok(!JSON.stringify(result.data).includes('SECRET'));
    assert.equal(result.data.patient.telephone, undefined);
    const save = { ...body, id_clinical_history: 'history', expected_revision: 4, consultation: { reason: 'patient says pain' } };
    assert.equal((await intake.save({ ...save, clinical_snapshot_json: { diagnosis: 'INJECTED' } })).status, 400);
    assert.equal((await intake.save({ ...save, consultation: { diagnosis: 'INJECTED' } })).status, 400);
    assert.equal((await intake.save({ ...save, expected_revision: 3 })).status, 409);
    assert.equal(commits, 0);
    result = await intake.save(save); assert.equal(result.status, 200, result.message); assert.equal(result.data.history.revision, 5);
    const updated = JSON.parse(history.clinical_snapshot_json);
    assert.equal(updated.consultation.reason, 'patient says pain');
    assert.equal(updated.consultation.private_extra, 'SECRET');
    assert.deepEqual(updated.diagnosis, original.diagnosis); assert.deepEqual(updated.therapeutic_plan, original.therapeutic_plan);
    assert.deepEqual(updated.allergies_medications, original.allergies_medications); assert.deepEqual(updated.custom, original.custom);
    assert.ok(!JSON.stringify(result.data).includes('SECRET'));
    assert.equal((await intake.save(save)).status, 409, 'Repeat of old revision must not overwrite');
    history.status = 'FINALIZED'; result = await intake.get(body);
    assert.equal(result.data.editable, false); assert.equal(result.data.consultation.reason, '');
    assert.equal((await intake.save({ ...save, expected_revision: 5 })).status, 409);
    history = null;
    assert.equal((await intake.save({ ...body, consultation: { reason: '' } })).status, 400);
    result = await intake.save({ ...body, consultation: { reason: 'New intake' } });
    assert.equal(result.status, 200, result.message); assert.equal(result.data.history.status, 'DRAFT');
    assert.equal((await intake.save({ ...body, consultation: { reason: 'retry' } })).status, 409);
    patientAvailable = false; assert.equal((await intake.save(save)).status, 403);
    assert.equal(domain.validateConsultation({ reason: 'x'.repeat(501) }) !== null, true);
    assert.deepEqual(domain.intakeFields({ sections: [{ key: 'diagnosis', fields: [{ key: 'reason', type: 'text' }] }] }), []);
    assert.deepEqual(domain.intakeFields({ sections: [{ key: 'consultation', fields: [{ key: 'reason', type: 'text' }, { key: 'main_symptoms', type: 'readonly' }, { key: 'private_custom', type: 'text' }, { key: 'current_condition', type: 'checkbox' }] }] }), ['reason']);
    console.log('PASS S17 access/intake: permissions/scopes, no implicit finance, narrow projection, strict payload, draft creation, safe merge, stale/closed rejection, tenant and patient availability. Mock SQL, real DAO logic.');
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const inject = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const profileA = { id_doctor_professional_profile: 'profile-a', id_login: 'doctor-a', professional_name: 'Doctora A' };
const profileB = { id_doctor_professional_profile: 'profile-b', id_login: 'doctor-b', professional_name: 'Doctor B' };
let doctors = [profileA, profileB], plan = 'enterprise', history = null, writes = [], events = [], allowed = true;
const body = { id_business: 'clinic', id_login: 'reception', patient_id: 'patient' };
const db = {
    transaction: async () => ({ commit: async () => {}, rollback: async () => {} }),
    async query(sql, options = {}) {
        if(sql.includes('FROM doctor_professional_profile d JOIN login l')) return doctors;
        if(sql.includes('FROM clinical_histories ch')) return history ? [{ ...history }] : [];
        const r = options.replacements || {};
        if(sql.startsWith('INSERT INTO clinical_histories')) {
            writes.push({ sql, r });
            history = { id_clinical_history: r.history, status: 'DRAFT', revision: 0, created_by_user_id: r.actor,
                doctor_responsible_profile_id: r.doctorProfile, doctor_responsible_user_id: r.doctorLogin,
                clinical_snapshot_json: r.snapshot, template_snapshot_json: r.schema };
        }
        if(sql.startsWith('UPDATE clinical_histories')) {
            writes.push({ sql, r });
            history = { ...history, revision: history.revision + 1, updated_by_user_id: r.actor,
                doctor_responsible_profile_id: r.doctorProfile, doctor_responsible_user_id: r.doctorLogin, clinical_snapshot_json: r.snapshot };
        }
        return [];
    }
};
inject('../../src/db/Sequelize.connection', db);
inject('../../src/util/effectivePermissions', { hasPermission: async () => allowed });
inject('../../src/Dao/mysql/licenseUsage.dao', { getBusinessPlan: async () => ({ plan }) });
inject('../../src/Dao/mysql/clinicalHistory.dao', { getPatient: async () => ({ id_person: 'patient', full_name: 'QA Patient' }),
    nextVersion: async () => 1, addEvent: async (...args) => events.push(args),
    resolveTemplateSnapshot: async () => ({ templateVersionId: null, templateSnapshotJson: null }) });
inject('../../src/Dao/mysql/patientAllergy.dao', { lockPatient: async () => true, getCurrent: async () => ({ review_status: 'UNKNOWN' }) });
const intake = require('../../src/Dao/mysql/clinicalIntake.dao');
(async () => {
    let result = await intake.get(body);
    assert.equal(result.data.suggested_doctor_profile_id, null, 'Clinic must make explicit choice');
    assert.deepEqual(Object.keys(result.data.doctors[0]).sort(), ['id_doctor_professional_profile', 'professional_name']);
    assert.equal(result.data.doctor_assignment_locked, false);
    doctors = [profileA]; result = await intake.get(body);
    assert.equal(result.data.suggested_doctor_profile_id, null, 'Clinic does not imply Professional when one doctor is active');
    plan = 'pro'; result = await intake.get(body); assert.equal(result.data.suggested_doctor_profile_id, 'profile-a');
    plan = 'unknown'; result = await intake.get(body); assert.equal(result.data.suggested_doctor_profile_id, null);
    plan = 'enterprise'; doctors = [profileA, profileB];
    const creation = { ...body, consultation: { reason: 'Patient reports symptoms' } };
    assert.equal((await intake.save(creation)).status, 400);
    assert.equal((await intake.save({ ...creation, doctor_responsible_profile_id: 'foreign-profile' })).status, 400);
    assert.equal((await intake.save({ ...creation, doctor_responsible_user_id: 'doctor-a' })).status, 400, 'Cannot inject login instead of validated profile');
    assert.equal(writes.length, 0);
    result = await intake.save({ ...creation, doctor_responsible_profile_id: 'profile-b' });
    assert.equal(result.status, 200, result.message);
    assert.equal(history.created_by_user_id, 'reception'); assert.equal(history.doctor_responsible_profile_id, 'profile-b');
    assert.equal(history.doctor_responsible_user_id, 'doctor-b'); assert.equal(history.finalized_by_user_id, undefined);
    assert.equal(result.data.doctor_assignment_locked, true); assert.equal(result.data.responsible_doctor.professional_name, 'Doctor B');
    assert.equal(events.find(e => e[4] === 'CREATED')[5].doctor_assignment.doctor_user_id, 'doctor-b');
    const id = history.id_clinical_history;
    const update = { ...body, id_clinical_history: id, expected_revision: 0, consultation: { reason: 'Updated report' } };
    assert.equal((await intake.save({ ...update, doctor_responsible_profile_id: 'profile-a' })).status, 403);
    assert.equal(writes.length, 1, 'Assigned doctor cannot be rerouted from intake');
    history.clinical_snapshot_json = JSON.stringify({ consultation: { reason: 'old' }, diagnosis: { private: 'protected diagnosis' } });
    result = await intake.save(update); assert.equal(result.status, 200, result.message);
    assert.equal(history.created_by_user_id, 'reception'); assert.equal(history.updated_by_user_id, 'reception');
    assert.equal(history.doctor_responsible_profile_id, 'profile-b');
    assert.equal(JSON.parse(history.clinical_snapshot_json).diagnosis.private, 'protected diagnosis');
    assert.equal((await intake.save(update)).status, 409, 'Stale revision takes precedence over assignment');
    doctors = [profileA]; result = await intake.get(body); assert.equal(result.data.assigned_doctor_available, false);
    assert.equal((await intake.save({ ...update, expected_revision: 1, doctor_responsible_profile_id: 'profile-b' })).status, 400);
    doctors = [profileA, profileB];
    history = { ...history, revision: 4, doctor_responsible_profile_id: null, doctor_responsible_user_id: null };
    result = await intake.save({ ...update, expected_revision: 4, doctor_responsible_profile_id: 'profile-a' });
    assert.equal(result.status, 200); assert.equal(history.doctor_responsible_user_id, 'doctor-a');
    assert.equal(history.created_by_user_id, 'reception', 'Assigning legacy orphan keeps creator');
    assert.equal(events.filter(e => e[4] === 'UPDATED').at(-1)[5].doctor_assignment.doctor_user_id, 'doctor-a');
    allowed = false; assert.equal((await intake.get(body)).status, 403); assert.equal((await intake.save(update)).status, 403);
    console.log('PASS S18 intake handoff: minimal professional catalog, pro-only suggestion, explicit clinic recipient, active doctor validation, author/responsible separation, orphan assignment, locked reassignment, audit, stale revision and permission denial. No DB.');
})().catch(error => { console.error(error); process.exitCode = 1; });

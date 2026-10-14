const assert = require('node:assert/strict');
const connectionPath = require.resolve('../../src/db/Sequelize.connection');
const prescriptionPath = require.resolve('../../src/Dao/mysql/prescription.dao');
const response = require('../../src/util/responsedata');
const { validateSavePlanTreatment, validateUpdatePlanTreatmentStatus } = require('../../src/validators/treatment.validator');
let queries = [], versions = [], current = null, commits = 0, rollbacks = 0, failCurrentWrite = false, failTooth = false;
const plan = { id_treatment_plan: 'qa-plan', id_business: 'qa-tenant', id_person: 'qa-patient', title: 'QA plan', status: 'active', diagnosis: null, notes: null, started_at: null };
const item = { id_patient_treatment: 'qa-item', id_treatment_plan: 'qa-plan', name: 'QA procedure', status: 'paused', cost: '100.00', teeth: [] };
const db = {
    async transaction() {
        const before = JSON.stringify({ versions, current });
        return { async commit() { commits++; }, async rollback() { rollbacks++; const data = JSON.parse(before); versions = data.versions; current = data.current; } };
    },
    async query(sql, options) {
        queries.push({ sql, options });
        const r = options.replacements;
        if (sql.startsWith('SELECT * FROM patient_treatment ')) return r.id === item.id_patient_treatment ? [item] : [];
        if (failTooth && sql.includes('INSERT INTO patient_treatment_tooth')) throw new Error('Simulated tooth write failure');
        if (sql.startsWith('SELECT') && sql.includes('treatment_plan_consent_version')) return versions;
        if (sql.startsWith('SELECT') && /\btreatment_plan_consent\b/.test(sql)) return current ? [current] : [];
        if (sql.includes('INSERT INTO treatment_plan_consent_version')) {
            versions.unshift({ id_consent_version: r.id, id_treatment_plan: 'qa-plan', revision: r.revision, request_id: r.request, consent_snapshot_json: r.consent, plan_snapshot_json: r.snapshot }); return [];
        }
        if (sql.includes('INSERT INTO treatment_plan_consent') || sql.includes('UPDATE treatment_plan_consent SET')) {
            if (failCurrentWrite) throw new Error('Simulated consent write failure');
            current = { patient_signature: r.patientSignature, id_treatment_plan_consent: r.id }; return [];
        }
        return [];
    }
};
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: db };
require.cache[prescriptionPath] = { id: prescriptionPath, filename: prescriptionPath, loaded: true, exports: { async getDoctor(id, tenant) {
    if (id !== 'qa-doctor' || tenant !== 'qa-tenant') return null;
    return { id_login: id, id_doctor_professional_profile: 'qa-profile', professional_profile_active: 1, can_sign_documents: 1, professional_name: 'QA Doctor', professional_license: 'QA license', signature_image: 'QA signature' };
} } };
const TreatmentPlanDao = require('../../src/Dao/mysql/treatmentPlan.dao');
const dao = new TreatmentPlanDao();
const body = { id_login: 'qa-user', id_business: 'qa-tenant', id_person: 'qa-patient', id_treatment_plan: 'qa-plan' };
const flags = { view: true, edit: true, create: true, consentSign: true, consentView: true, costView: true, costEdit: true };
const baseContext = dao.context.bind(dao);
dao.permissions = async () => flags;
dao.context = async (_body, permission) => flags[permission] ? { permissions: flags, patient: { id_person: 'qa-patient' } } : { error: response.forbidden('Denied') };
dao.active = async () => plan;
dao.items = async () => [item];
dao.plans = async () => [plan];
dao.configuration = async () => ({});

(async () => {
    const invalid = data => validateSavePlanTreatment({ body: { id_person: 'qa-patient', name: 'QA', ...data } });
    for (const values of [{ name: '  ' }, { name: 'x'.repeat(256) }, { cost: -1 }, { cost: '1.234' }, { cost: true }, { estimated_start_date: '2026-02-30' }, { estimated_start_date: '2026-10-14', estimated_end_date: '2026-10-13' }]) assert.equal(invalid(values).isValid, false);
    assert.equal(invalid({ cost: 0 }).isValid, true);
    assert.equal(invalid({ cost: null, estimated_start_date: '', estimated_end_date: '' }).isValid, true);
    assert.equal(validateUpdatePlanTreatmentStatus({ body: { id_person: 'qa-patient', id_patient_treatment: 'qa-item', status: 'typo' } }).isValid, false);
    flags.edit = false;
    assert.equal((await dao.savePlanTreatment({ ...body, id_patient_treatment: 'qa-item', name: 'QA' })).status, 403);
    assert.equal(queries.length, 0, 'Permission rejection cannot mutate or read clinical rows');
    flags.cancel = true;
    assert.equal((await dao.updatePlanTreatmentStatus({ ...body, id_patient_treatment: 'qa-item', status: 'in_progress' })).status, 403, 'Cancel permission cannot start a treatment');
    flags.edit = true;
    const beforeRollback = rollbacks;
    queries = []; failTooth = true;
    assert.notEqual((await dao.savePlanTreatment({ ...body, id_patient_treatment: 'qa-item', name: 'QA', teeth: ['12'] })).status, 200);
    assert.equal(rollbacks, beforeRollback + 1);
    const itemWrites = queries.filter(q => /^(INSERT|UPDATE|DELETE)/.test(q.sql));
    assert.ok(itemWrites.some(q => q.sql.startsWith('UPDATE patient_treatment')));
    assert.ok(itemWrites.some(q => q.sql.startsWith('DELETE FROM patient_treatment_tooth')));
    assert.ok(itemWrites.every(q => q.options.transaction === itemWrites[0].options.transaction), 'Treatment and tooth writes share one transaction');
    failTooth = false;
    const getPlan = dao.getPlan;
    dao.getPlan = async () => response.error('Simulated refresh failure');
    const savedWithoutRefresh = await dao.savePlanTreatment({ ...body, name: 'QA new', request_id: 'qa-new', teeth: [] });
    assert.equal(savedWithoutRefresh.status, 200);
    assert.equal(savedWithoutRefresh.data.persisted, true);
    assert.equal(savedWithoutRefresh.data.refreshRequired, true);
    dao.getPlan = getPlan;
    const snapshot = { ...plan, treatments: [item] };
    const consentBody = { ...body, doctor_user_id: 'qa-doctor', request_id: 'qa-save-1', review_token: dao.reviewToken(snapshot), patient_signature: 'QA new signature', doctor_name_snapshot: 'Untrusted doctor name' };
    current = { id_treatment_plan_consent: 'qa-original', patient_signature: 'QA original signature', declare_text_snapshot: 'Original text', signed_at: '2026-01-01' };
    assert.equal((await dao.savePlanConsent(consentBody)).status, 200);
    assert.equal(versions.length, 2);
    assert.equal(JSON.parse(versions[1].consent_snapshot_json).patient_signature, 'QA original signature');
    assert.equal(versions[1].plan_snapshot_json, null, 'Legacy plan content must not be invented');
    assert.equal(JSON.parse(versions[0].consent_snapshot_json).doctor_name_snapshot, 'QA Doctor', 'Doctor metadata comes from tenant-scoped profile');
    assert.equal(JSON.parse(versions[0].plan_snapshot_json).treatments[0].status, 'paused');
    const writes = queries.filter(q => /^(INSERT|UPDATE)/.test(q.sql)).length;
    assert.equal((await dao.savePlanConsent(consentBody)).status, 200);
    assert.equal(versions.length, 2, 'Retry cannot create duplicate signature versions');
    assert.equal(queries.filter(q => /^(INSERT|UPDATE)/.test(q.sql)).length, writes);
    const first = JSON.parse(versions[0].plan_snapshot_json);
    item.name = 'Changed after signature';
    assert.equal(first.treatments[0].name, 'QA procedure', 'Signed plan snapshot stays immutable');
    assert.equal((await dao.savePlanConsent({ ...consentBody, request_id: 'qa-save-2' })).status, 400, 'Changed plan needs renewed review');
    failCurrentWrite = true;
    assert.notEqual((await dao.savePlanConsent({ ...consentBody, request_id: 'qa-save-2', review_token: dao.reviewToken({ ...plan, treatments: [item] }) })).status, 200);
    assert.equal(versions.length, 2, 'A failed current write rolls back the version insert');
    failCurrentWrite = false;
    assert.equal((await dao.savePlanConsent({ ...consentBody, doctor_user_id: 'other-tenant', request_id: 'qa-save-2', review_token: dao.reviewToken({ ...plan, treatments: [item] }) })).status, 400);
    flags.costView = false;
    let dto = await dao.getPlan(body);
    assert.equal(dto.status, 200);
    assert.equal('cost' in dto.data.activePlan.treatments[0], false);
    assert.equal('cost' in dto.data.activePlan.consent.plan_snapshot.treatments[0], false);
    flags.consentView = false;
    queries = [];
    dto = await dao.getPlan(body);
    assert.equal(dto.data.activePlan.consent, null);
    assert.equal(dto.data.activePlan.consent_versions.length, 0);
    assert.equal(queries.some(q => /SELECT \* FROM treatment_plan_consent\b/.test(q.sql)), false);
    assert.equal(queries.some(q => q.sql.includes('FROM treatment_plan_consent_version') && q.sql.includes('consent_snapshot_json')), false);
    flags.view = false;
    dao.context = baseContext;
    queries = [];
    assert.equal((await dao.getPlan(body)).status, 403);
    assert.equal(queries.length, 0);
    assert.ok(commits >= 2 && rollbacks >= 2);
    console.log('PASS treatment plans: validation, permission denials, status authorization, atomic tooth rollback, committed-save/failed-refresh distinction, immutable legacy/new consent versions, reviewed content, tenant doctor, idempotent retry, rollback, cost/signature redaction. Mock database only.');
})().catch(error => { console.error(error); process.exitCode = 1; });

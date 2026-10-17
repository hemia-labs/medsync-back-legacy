const assert = require('node:assert/strict');
const connectionPath = require.resolve('../../src/db/Sequelize.connection');
const response = require('../../src/util/responsedata');
let calls = [], failVersion = false, commits = 0, rollbacks = 0;
const plan = { id_treatment_plan: 'qa-plan', id_business: 'qa-tenant', id_person: 'qa-patient', title: 'Original plan', status: 'active', started_at: '2026-10-13' };
const item = { id_patient_treatment: 'qa-item', id_treatment_plan: 'qa-plan', name: 'Original procedure', status: 'pending', cost: '100.00', teeth: [] };
let state;
const db = {
    async transaction() { const saved = JSON.stringify(state); return { async commit() { commits++; }, async rollback() { rollbacks++; state = JSON.parse(saved); } }; },
    async query(sql, options) {
        calls.push({ sql, options }); const r = options.replacements;
        if (sql.includes('SELECT pd.*, link.')) return [{ ...state.document, id_treatment_plan: 'qa-plan', consent_snapshot_json: state.binding.consent_snapshot_json }];
        if (/SELECT.*FROM treatment_plan_consent_document/s.test(sql)) return [state.binding];
        if (sql.includes('FROM treatment_plan_consent_version') && sql.startsWith('SELECT')) return state.versions;
        if (/SELECT.*FROM treatment_plan_consent\b/s.test(sql)) return state.current ? [state.current] : [];
        if (sql.includes('FROM treatment_plan WHERE')) return [{ ...plan }];
        if (sql.includes('FROM patient_treatment WHERE')) return [{ ...item }];
        if (sql.includes('FROM patient_treatment_tooth')) return [];
        if (sql.includes('FROM patient_documents')) return [{ ...state.document }];
        if (sql.includes('FROM patient_document_signatures')) return state.signatures;
        if (sql.includes('INSERT INTO patient_document_signatures')) {
            state.signatures.push({ id_patient_document: 'qa-document', signature_role: r._signature_role || r.role, signer_name_snapshot: r._signer_name_snapshot || r.name, signature_image: r._signature_image || r.signature, signed_at: '2026-10-13T12:00:00Z' }); return [];
        }
        if (sql.includes('UPDATE patient_documents')) { state.document.status = r._status || r.status || 'CANCELADO'; return []; }
        if (sql.includes('UPDATE document_signature_requests')) { state.request.status = r._signed_status || r._opened_status || 'revoked'; return []; }
        if (sql.includes('INSERT INTO treatment_plan_consent_version')) {
            if(failVersion) throw new Error('Simulated version failure');
            state.versions.unshift({ revision: r.revision, request_id: r.request, consent_snapshot_json: r.consent, plan_snapshot_json: r.snapshot }); return [];
        }
        if (sql.includes('UPDATE treatment_plan_consent') || sql.includes('INSERT INTO treatment_plan_consent (')) { state.current = { patient_signature: r.patientSignature, id_patient_document: r.document }; return []; }
        return [];
    }
};
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: db };
const bridge = require('../../src/services/documentSignature/treatmentPlanConsentDocument.service');
const publicDao = require('../../src/Dao/mysql/publicDocumentSignature.dao');
const TreatmentPlanDao = require('../../src/Dao/mysql/treatmentPlan.dao');
const token = 'a'.repeat(43);
const image = 'data:image/png;base64,iVBORw0KGgo=';
const frozen = { declare_text_snapshot: 'Originally reviewed consent', doctor_name_snapshot: 'QA Doctor', professional_license_snapshot: 'QA license',
    doctor_signature_snapshot: 'QA professional signature', responsible_doctor_user_id: 'qa-doctor', responsible_doctor_profile_id: 'qa-profile',
    signature_requirements: { requires_patient_signature: 1, requires_tutor_signature: 0, requires_doctor_signature: 1, requires_witness1_signature: 0, requires_witness2_signature: 0 } };
function reset() {
    plan.title = 'Original plan'; calls = []; failVersion = false;
    const snapshot = { ...plan, patient: { name: 'Originally', surname: 'Named' }, treatments: [{ ...item }] };
    state = { binding: { id_patient_document: 'qa-document', id_treatment_plan: 'qa-plan', content_fingerprint: bridge.fingerprint(snapshot), plan_snapshot_json: JSON.stringify(snapshot), consent_snapshot_json: JSON.stringify(frozen) },
        document: { id_patient_document: 'qa-document', id_business: 'qa-tenant', id_person: 'qa-patient', treatment_plan_id: 'qa-plan', document_type: 'TREATMENT_PLAN_CONSENT', origin: 'TREATMENT_PLAN',
            title: 'QA consent', status: 'PENDIENTE_FIRMA', content_html_snapshot: '<p>Originally reviewed document</p>', created_at: '2026-10-13', doctor_signature_snapshot: 'QA professional signature',
            requires_patient_signature: 0, requires_tutor_signature: 1 }, // Changed live template flags must not change a prepared document.
        request: { id_document_signature_request: 'qa-request', id_business: 'qa-tenant', id_person: 'qa-patient', id_patient_document: 'qa-document', document_type: 'TREATMENT_PLAN_CONSENT', signature_role: 'PATIENT',
            channel: 'qr', status: 'pending', expires_at: new Date(Date.now() + 3600000).toISOString() }, signatures: [], versions: [],
        current: { id_treatment_plan_consent: 'qa-old-consent', patient_signature: 'Old immutable signature', declare_text_snapshot: 'Old immutable text' } };
}
publicDao.getRequestByHash = async () => ({ ...state.request });
publicDao.getPatient = async () => ({ id_person: 'qa-patient', name: 'Current', surname: 'Name' });
publicDao.getBusiness = async () => ({ name: 'QA Clinic' });

(async () => {
    reset();
    const originalLegacyHtml = '<p onclick="attack()">Original</p><script>attack()</script>';
    state.document.content_html_snapshot = originalLegacyHtml;
    state.document.signed_content_html_snapshot = originalLegacyHtml;
    const safePlanDocuments = await bridge.documentsForPatient({ id_business: 'qa-tenant', id_person: 'qa-patient' });
    assert.equal(safePlanDocuments.documents[0].content_html_snapshot, '<p>Original</p>');
    assert.equal(safePlanDocuments.documents[0].signed_content_html_snapshot, '<p>Original</p>');
    assert.equal(state.document.signed_content_html_snapshot, originalLegacyHtml, 'Treatment display must not rewrite historical content');
    reset();
    const opened = await publicDao.openByToken(token);
    assert.equal(opened.status, 200);
    assert.equal(opened.data.patient.display_name, 'Originally Named');
    assert.equal(opened.data.document.content_html_snapshot, '<p>Originally reviewed document</p>');
    const signed = await publicDao.signByToken(token, { accepted_electronic_signature: true, signature_image: image });
    assert.equal(signed.status, 200);
    assert.equal(state.document.status, 'FIRMADO');
    assert.equal(state.versions.length, 2);
    assert.equal(JSON.parse(state.versions[1].consent_snapshot_json).patient_signature, 'Old immutable signature');
    assert.equal(JSON.parse(state.versions[0].plan_snapshot_json).treatments[0].name, 'Original procedure');
    assert.equal(state.current.id_patient_document, 'qa-document');
    assert.equal(state.current.patient_signature, image);
    assert.equal(state.versions[0].request_id, 'qa-document');
    const writes = calls.filter(call => call.sql.includes('INSERT')).length;
    assert.notEqual((await publicDao.signByToken(token, { accepted_electronic_signature: true, signature_image: image })).status, 200);
    assert.equal(calls.filter(call => call.sql.includes('INSERT')).length, writes, 'Used link cannot insert another signature/version');
    reset(); failVersion = true;
    assert.equal((await publicDao.signByToken(token, { accepted_electronic_signature: true, signature_image: image })).status, 500);
    assert.equal(state.document.status, 'PENDIENTE_FIRMA');
    assert.equal(state.request.status, 'pending');
    assert.equal(state.signatures.length, 0);
    assert.equal(state.versions.length, 0, 'All writes roll back if the plan version cannot be saved');
    reset(); plan.title = 'Changed plan';
    assert.notEqual((await publicDao.openByToken(token)).status, 200, 'Stale content is not exposed as a current document');
    assert.notEqual((await publicDao.signByToken(token, { accepted_electronic_signature: true, signature_image: image })).status, 200);
    assert.equal(state.signatures.length, 0);
    await bridge.invalidateStale({ id_business: 'qa-tenant', id_person: 'qa-patient', id_login: 'qa-doctor' }, {});
    assert.equal(state.document.status, 'CANCELADO'); assert.equal(state.request.status, 'revoked');
    reset();
    const dao = new TreatmentPlanDao();
    const historicalConsent = { declare_text_snapshot: originalLegacyHtml, consent_text_snapshot: 'Text & information', doctor_signature_snapshot: image };
    const safeHistoricalConsent = dao.visibleConsent(historicalConsent, { costView: true });
    assert.equal(safeHistoricalConsent.declare_text_snapshot, '<p>Original</p>');
    assert.equal(safeHistoricalConsent.consent_text_snapshot, 'Text & information');
    assert.equal(historicalConsent.declare_text_snapshot, originalLegacyHtml);
    dao.context = async () => ({ permissions: { consentSign: true, view: true } });
    dao.getPlan = async () => response.success({ patient: { id_person: 'qa-patient' } }, 'QA');
    assert.equal((await dao.signPreparedConsent({ id_business: 'qa-tenant', id_person: 'qa-patient', id_login: 'qa-doctor', id_patient_document: 'qa-document', patient_signature: image, signature_role: 'PATIENT', signer_name: 'QA Patient' })).status, 200);
    assert.equal(state.document.status, 'FIRMADO'); assert.equal(state.versions.length, 2);
    assert.equal(state.request.status, 'revoked', 'Local capture invalidates outstanding links for that role');
    const count = state.versions.length;
    assert.equal((await dao.signPreparedConsent({ id_business: 'qa-tenant', id_person: 'qa-patient', id_login: 'qa-doctor', id_patient_document: 'qa-document', patient_signature: image, signature_role: 'PATIENT' })).status, 200);
    assert.equal(state.versions.length, count, 'Local retry is idempotent');
    const lockSql = calls.filter(call => call.sql.includes('FOR UPDATE'));
    assert.ok(lockSql[0].sql.includes('FROM person'), 'Patient lock precedes document/signature locks');
    reset();
    state.document.origin = 'CLINICAL_HISTORY'; state.document.document_type = 'SENSITIVE_DATA_CONSENT'; state.document.treatment_plan_id = null;
    state.document.requires_patient_signature = 1; state.document.requires_tutor_signature = 0;
    state.request.document_type = 'SENSITIVE_DATA_CONSENT';
    assert.equal((await publicDao.signByToken(token, { accepted_electronic_signature: true, signature_image: image })).status, 200);
    assert.equal(state.document.status, 'FIRMADO');
    assert.equal(state.versions.length, 0, 'Existing clinical-history signatures do not mutate treatment consents');
    assert.equal(calls.some(call => call.sql.includes('treatment_plan_consent_document')), false);
    assert.ok(commits && rollbacks);
    console.log('PASS plan consent documents: frozen content/roles/identity, remote and local atomic version sync, legacy signature retention, used-link/local retry safety, rollback, changed-plan rejection and revocation. Mock database/email only; no real signatures or messages.');
})().catch(error => { console.error(error); process.exitCode = 1; });

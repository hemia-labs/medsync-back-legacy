const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { createHash } = require('node:crypto');
const sequelize = require('../../db/Sequelize.connection');
const { safeDocumentForDisplay } = require('./documentHtml.service');
const eq = (column, value) => `${column} COLLATE utf8mb4_unicode_ci = ${value} COLLATE utf8mb4_unicode_ci`;
const query = (sql, replacements, transaction, type = QueryTypes.SELECT) => sequelize.query(sql, { replacements, transaction, type });
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const date = value => !value ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const isLinked = document => document && document.origin === 'TREATMENT_PLAN' && document.treatment_plan_id;
const missingTable = error => (error.original || error).code === 'ER_NO_SUCH_TABLE';
const keys = document => ({ business: document.id_business, patient: document.id_person, plan: document.treatment_plan_id, document: document.id_patient_document });

function fingerprint(plan) {
    const data = { title: plan.title || '', diagnosis: plan.diagnosis || '', notes: plan.notes || '', started_at: date(plan.started_at),
        treatments: (plan.treatments || []).map(item => ({ id: item.id_patient_treatment, name: item.name || '', description: item.description || '', category: item.category || '',
            status: item.status, cost: item.cost === null || item.cost === undefined || item.cost === '' ? null : String(Number(item.cost)),
            start: date(item.estimated_start_date), end: date(item.estimated_end_date), notes: item.notes || '', teeth: [...(item.teeth || [])].map(String).sort() })).sort((a, b) => a.id.localeCompare(b.id)) };
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
async function binding(document, transaction) {
    if (!isLinked(document)) return null;
    const rows = await query(`SELECT * FROM treatment_plan_consent_document WHERE ${eq('id_patient_document', ':document')}
        AND ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')} AND ${eq('id_treatment_plan', ':plan')}`, keys(document), transaction);
    return rows[0] || null;
}
async function decorate(document, transaction) {
    if (!isLinked(document)) return document;
    const prepared = await binding(document, transaction);
    if (!prepared) throw new Error('Plan consent document has no binding');
    const consent = parse(prepared.consent_snapshot_json);
    const patient = (parse(prepared.plan_snapshot_json) || {}).patient || {};
    return { ...document, ...consent.signature_requirements, patient_name_snapshot: patient.fullname || `${patient.name || ''} ${patient.surname || ''}`.trim() };
}
async function currentPlan(document, transaction) {
    const values = keys(document);
    const plans = await query(`SELECT * FROM treatment_plan WHERE ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')}
        AND ${eq('id_treatment_plan', ':plan')} AND active = 1`, values, transaction);
    if (!plans[0] || plans[0].status !== 'active') return null;
    const items = await query(`SELECT * FROM patient_treatment WHERE ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')}
        AND ${eq('id_treatment_plan', ':plan')} AND active = 1`, values, transaction);
    const teeth = await query(`SELECT ptt.id_patient_treatment, ptt.tooth_number FROM patient_treatment_tooth ptt
        INNER JOIN patient_treatment pt ON pt.id_patient_treatment = ptt.id_patient_treatment AND pt.id_business = ptt.id_business
        WHERE ${eq('pt.id_business', ':business')} AND ${eq('pt.id_person', ':patient')} AND ${eq('pt.id_treatment_plan', ':plan')} AND pt.active = 1`, values, transaction);
    return { ...plans[0], treatments: items.map(item => ({ ...item, teeth: teeth.filter(tooth => tooth.id_patient_treatment === item.id_patient_treatment).map(tooth => String(tooth.tooth_number)).sort() })) };
}
async function assertCurrent(document, transaction) {
    if (!isLinked(document)) return true;
    const prepared = await binding(document, transaction);
    const current = await currentPlan(document, transaction);
    return Boolean(prepared && current && prepared.content_fingerprint === fingerprint(current));
}
async function documentsForPatient(body, transaction, includeContent = true) {
    try {
        const rows = await query(`SELECT pd.*, link.id_treatment_plan, link.consent_snapshot_json, link.prepared_by
            FROM treatment_plan_consent_document link INNER JOIN patient_documents pd ON pd.id_patient_document = link.id_patient_document
                AND pd.id_business = link.id_business AND pd.id_person = link.id_person
            WHERE ${eq('link.id_business', ':business')} AND ${eq('link.id_person', ':patient')} AND pd.active = 1 ORDER BY link.prepared_at DESC, pd.id_patient_document DESC`,
        { business: body.id_business, patient: body.id_person }, transaction);
        const signatures = rows.length ? await query(`SELECT id_patient_document, signature_role, signer_name_snapshot, signature_image, signed_at FROM patient_document_signatures
            WHERE ${eq('id_business', ':business')} AND id_patient_document IN (:ids)`, { business: body.id_business, ids: rows.map(row => row.id_patient_document) }, transaction) : [];
        return { available: true, documents: rows.map(row => {
            const frozen = parse(row.consent_snapshot_json);
            const result = { ...row, ...frozen.signature_requirements, includes_costs: Boolean(frozen.includes_costs), signatures: signatures.filter(signature => signature.id_patient_document === row.id_patient_document) };
            delete result.consent_snapshot_json;
            if (!includeContent) {
                if (!['BORRADOR', 'PENDIENTE_FIRMA'].includes(row.status)) { delete result.content_html_snapshot; delete result.doctor_signature_snapshot; }
                delete result.signed_content_html_snapshot;
                delete result.pdf_url;
                result.signatures = result.signatures.map(signature => ({ signature_role: signature.signature_role, signed_at: signature.signed_at }));
            }
            return safeDocumentForDisplay(result);
        }) };
    } catch(error) { if (missingTable(error)) return { available: false, documents: [] }; throw error; }
}
async function invalidateStale(body, transaction) {
    const { documents } = await documentsForPatient(body, transaction, false);
    for (const document of documents.filter(doc => ['BORRADOR', 'PENDIENTE_FIRMA'].includes(doc.status))) {
        if (await assertCurrent(document, transaction)) continue;
        const values = { ...keys(document), actor: body.id_login || null };
        await query(`UPDATE patient_documents SET status = 'CANCELADO', updated_at = NOW(), updated_by = :actor
            WHERE ${eq('id_patient_document', ':document')} AND ${eq('id_business', ':business')} AND status IN ('BORRADOR', 'PENDIENTE_FIRMA')`, values, transaction, QueryTypes.UPDATE);
        await query(`UPDATE document_signature_requests SET status = 'revoked', revoked_at = NOW(), revoked_by = :actor, updated_at = NOW()
            WHERE ${eq('id_patient_document', ':document')} AND ${eq('id_business', ':business')} AND status IN ('pending', 'opened')`, values, transaction, QueryTypes.UPDATE);
        await query(`INSERT INTO patient_document_events (id_patient_document_event, id_patient_document, id_business, event_type, notes, created_at, created_by)
            VALUES (:id, :document, :business, 'CANCELLED', 'El plan cambió o se cerró. Prepara una nueva versión para firma.', NOW(), :actor)`, { ...values, id: uuidv4() }, transaction, QueryTypes.INSERT);
    }
}
async function syncSigned(document, transaction, actor = null) {
    if (!isLinked(document) || document.status !== 'FIRMADO') return;
    const prepared = await binding(document, transaction);
    if (!prepared || !await assertCurrent(document, transaction)) throw new Error('Plan changed before signature');
    const values = { ...keys(document), actor };
    const versions = await query(`SELECT * FROM treatment_plan_consent_version WHERE ${eq('id_business', ':business')}
        AND ${eq('id_treatment_plan', ':plan')} ORDER BY revision DESC FOR UPDATE`, values, transaction);
    if (versions.some(version => version.request_id === document.id_patient_document)) return;
    const current = (await query(`SELECT * FROM treatment_plan_consent WHERE ${eq('id_business', ':business')}
        AND ${eq('id_treatment_plan', ':plan')} AND active = 1 FOR UPDATE`, values, transaction))[0];
    const signatures = await query(`SELECT signature_role, signer_name_snapshot, signature_image, signed_at FROM patient_document_signatures
        WHERE ${eq('id_patient_document', ':document')} AND ${eq('id_business', ':business')}`, values, transaction);
    const patientSignature = signatures.find(signature => ['PATIENT', 'TUTOR'].includes(signature.signature_role));
    if (!patientSignature) throw new Error('Patient or guardian signature missing');
    let revision = versions[0] ? versions[0].revision : 0;
    const addVersion = async (consent, plan, request) => {
        await query(`INSERT INTO treatment_plan_consent_version (id_consent_version, id_business, id_person, id_treatment_plan, revision, request_id, consent_snapshot_json, plan_snapshot_json, created_at, created_by)
            VALUES (:id, :business, :patient, :plan, :revision, :request, :consent, :snapshot, NOW(), :actor)`,
        { ...values, id: uuidv4(), revision: ++revision, request, consent: JSON.stringify(consent), snapshot: plan ? JSON.stringify(plan) : null }, transaction, QueryTypes.INSERT);
    };
    if (current && !versions.length) await addVersion(current, null, null);
    const frozen = parse(prepared.consent_snapshot_json);
    const consent = { ...frozen, id_treatment_plan_consent: current ? current.id_treatment_plan_consent : uuidv4(), id_patient_document: document.id_patient_document,
        doctor_signature_snapshot: frozen.doctor_signature_snapshot || (signatures.find(signature => signature.signature_role === 'DOCTOR') || {}).signature_image || null,
        patient_signature: patientSignature.signature_image, patient_signature_role: patientSignature.signature_role, patient_signer_name_snapshot: patientSignature.signer_name_snapshot,
        signatures_snapshot: signatures, signed_at: document.signed_at || new Date().toISOString(), signed_by_user_id: actor, created_at: document.created_at };
    await addVersion(consent, parse(prepared.plan_snapshot_json), document.id_patient_document);
    const replacements = { ...values, id: consent.id_treatment_plan_consent, declare: consent.declare_text_snapshot || null, text: consent.consent_text_snapshot || null,
        patientSignature: consent.patient_signature, doctorSignature: consent.doctor_signature_snapshot || null, doctorName: consent.doctor_name_snapshot,
        license: consent.professional_license_snapshot, doctorId: consent.responsible_doctor_user_id, profileId: consent.responsible_doctor_profile_id };
    if (current) await query(`UPDATE treatment_plan_consent SET id_patient_document=:document, declare_text_snapshot=:declare, consent_text_snapshot=:text, patient_signature=:patientSignature,
        doctor_signature_snapshot=:doctorSignature, doctor_name_snapshot=:doctorName, professional_license_snapshot=:license, responsible_doctor_user_id=:doctorId,
        responsible_doctor_profile_id=:profileId, signed_at=NOW(), signed_by_user_id=:actor, updated_at=NOW(), updated_by=:actor
        WHERE ${eq('id_treatment_plan_consent', ':id')} AND ${eq('id_business', ':business')} AND ${eq('id_treatment_plan', ':plan')}`, replacements, transaction, QueryTypes.UPDATE);
    else await query(`INSERT INTO treatment_plan_consent (id_treatment_plan_consent, id_patient_document, id_business, id_person, id_treatment_plan, declare_text_snapshot, consent_text_snapshot,
        patient_signature, doctor_signature_snapshot, doctor_name_snapshot, professional_license_snapshot, responsible_doctor_user_id, responsible_doctor_profile_id, signed_at, signed_by_user_id, active, created_at, created_by)
        VALUES (:id, :document, :business, :patient, :plan, :declare, :text, :patientSignature, :doctorSignature, :doctorName, :license, :doctorId, :profileId, NOW(), :actor, 1, NOW(), :actor)`, replacements, transaction, QueryTypes.INSERT);
}
module.exports = { fingerprint, isLinked, binding, decorate, currentPlan, assertCurrent, documentsForPatient, invalidateStale, syncSigned };

const { QueryTypes } = require('sequelize');
const { v4: uuid } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const permissions = require('../../util/effectivePermissions');
const domain = require('../../domain/sensitiveConsent');
const eq = (a, b) => `${a} COLLATE utf8mb4_unicode_ci = ${b} COLLATE utf8mb4_unicode_ci`;
const reply = (status, code, message, data = {}) => ({ status, message, data: { ...data, code } });
const conflict = () => reply(409, 'CONSENT_REVIEW_CHANGED', 'El consentimiento cambió. Revisa los documentos antes de confirmar; tu motivo se conserva.');

async function select(sql, replacements, transaction) {
    return sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
}

// Common first lock for every writer of patient consent. No DDL or new mutex table.
async function lockPatient(patient, business, transaction) {
    const rows = await select(`SELECT id_person, active FROM person WHERE ${eq('id_person', ':patient')}
        AND ${eq('id_business', ':business')} FOR UPDATE`, { patient, business }, transaction);
    return rows[0] || null;
}

async function lockDocumentPatient(document, business, transaction) {
    const rows = await select(`SELECT id_person FROM patient_documents WHERE ${eq('id_patient_document', ':document')}
        AND ${eq('id_business', ':business')} LIMIT 1`, { document, business }, transaction);
    return rows[0] ? lockPatient(rows[0].id_person, business, transaction) : null;
}

async function load(patient, business, transaction = null) {
    const documents = await select(`SELECT id_patient_document, id_business, id_person, document_type, title, active, status,
        DATE_FORMAT(signed_at, '%Y-%m-%dT%H:%i:%s.%f') AS signed_at,
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%f') AS created_at,
        refusal_reason, responsible_doctor_user_id, responsible_doctor_profile_id, doctor_name_snapshot
        FROM patient_documents WHERE ${eq('id_person', ':patient')} AND ${eq('id_business', ':business')}
        AND document_type = 'SENSITIVE_DATA_CONSENT' ORDER BY id_patient_document ${transaction ? 'FOR UPDATE' : ''}`,
    { patient, business }, transaction);
    const events = await select(`SELECT e.id_patient_document_event, e.id_patient_document, e.id_business, e.event_type, e.notes,
        DATE_FORMAT(e.created_at, '%Y-%m-%dT%H:%i:%s.%f') AS created_at, e.created_by
        FROM patient_document_events e INNER JOIN patient_documents d ON ${eq('d.id_patient_document', 'e.id_patient_document')}
        AND ${eq('d.id_business', 'e.id_business')} WHERE ${eq('d.id_person', ':patient')} AND ${eq('d.id_business', ':business')}
        AND d.document_type = 'SENSITIVE_DATA_CONSENT' AND e.event_type IN ('REFUSAL_REGISTERED', 'REFUSAL_SUPERSEDED', 'SUPERSEDES_REFUSAL')
        ORDER BY e.id_patient_document_event ${transaction ? 'FOR UPDATE' : ''}`, { patient, business }, transaction);
    const resolved = domain.resolve(documents, events);
    return { documents, events, ...resolved,
        hasLaterSignedConsent: resolved.remainingRefusals.some(refusal => documents.some(signed => domain.eligible(refusal, signed, events))) };
}

async function authority(body, transaction) {
    // Rechecked before idempotent success too. Lock grants/actor until commit.
    const options = { enabledCatalog: true, transaction, lock: true };
    const view = await permissions.hasPermission(body.id_login, 'documents.view', options);
    const sign = view && await permissions.hasPermission(body.id_login, 'documents.sign', options);
    const profiles = view ? await select(`SELECT p.id_doctor_professional_profile, p.id_login, p.professional_name,
        p.professional_license, p.is_active, p.can_sign_documents, r.code AS role FROM doctor_professional_profile p
        INNER JOIN login l ON ${eq('l.id_login', 'p.id_login')} AND ${eq('l.id_business', 'p.id_business')}
        INNER JOIN rol r ON ${eq('r.id_rol', 'l.id_rol')} AND r.active = 1
        WHERE ${eq('p.id_business', ':business')} AND ${eq('p.id_login', ':actor')} AND l.active = 1
        ${transaction ? 'FOR SHARE' : ''}`, { business: body.id_business, actor: body.id_login }, transaction) : [];
    const profile = profiles[0] || null;
    const enabled = Boolean(sign && profile && Number(profile.is_active) === 1 && Number(profile.can_sign_documents) === 1
        && ['doctor', 'admin', 'business_admin'].includes(String(profile.role).toLowerCase())
        && profile.professional_name && profile.professional_license);
    return { view, enabled, profile };
}

function canAuthorize(access, signed, actor) {
    return access.enabled && signed.responsible_doctor_user_id === actor
        && signed.responsible_doctor_profile_id === access.profile.id_doctor_professional_profile;
}

const reviewToken = (state, access, actor) => domain.hash([state.token, actor, access.view, access.enabled, access.profile]);

// DATE_FORMAT preserves the exact database representation for evidence hashes.
// Sequelize uses UTC for this connection; only the public display projection gets
// an explicit zone. Never change the stored pair's t/u/f or domain input dates.
const displayInstant = value => {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value}Z` : value;
};

function preview(state, access, actor) {
    const candidates = [];
    for (const refusal of state.remainingRefusals) for (const signed of state.documents) {
        if (domain.eligible(refusal, signed, state.events)) candidates.push({ refusal_id: refusal.id_patient_document,
            signed_id: signed.id_patient_document, can_authorize: canAuthorize(access, signed, actor),
            remaining_refusal_ids: state.remainingRefusals.filter(row => row !== refusal).map(row => row.id_patient_document),
            predicted_status: state.remainingRefusals.length > 1 ? domain.REFUSAL : 'FIRMADO' });
    }
    return { consent_token: state.token, substitution_token: reviewToken(state, access, actor), consent_status: state.status, consent_document_id: state.document?.id_patient_document || null,
        documents: state.documents.map(document => ({ ...document,
            created_at: displayInstant(document.created_at), signed_at: displayInstant(document.signed_at),
            refusal_at: displayInstant(domain.refusalEvidence(document, state.events).latest?.created_at) })),
        pairs: state.pairs.map(pair => ({ ...pair, created_at: displayInstant(pair.created_at) })),
        diagnostics: state.diagnostics, candidates };
}

async function review(body) {
    const transaction = await sequelize.transaction();
    try {
        // Authenticate/authorize before exposing existence; patient precedes document/profile locks.
        if (!await permissions.hasPermission(body.id_login, 'documents.view', { enabledCatalog: true })) {
            await transaction.rollback(); return reply(403, 'PERMISSION_DENIED', 'No tienes permiso para consultar documentos.');
        }
        if (!await lockPatient(body.id_person, body.id_business, transaction)) {
            await transaction.rollback(); return reply(404, 'PATIENT_NOT_FOUND', 'Paciente no disponible.');
        }
        const state = await load(body.id_person, body.id_business, transaction);
        const access = await authority(body, transaction);
        if (!access.view) { await transaction.rollback(); return reply(403, 'PERMISSION_DENIED', 'No tienes permiso para consultar documentos.'); }
        const result = preview(state, access, body.id_login);
        await transaction.commit();
        return { status: 200, data: result, message: 'Consentimiento verificado.' };
    } catch (error) { if (!transaction.finished) await transaction.rollback(); throw error; }
}

async function substitute(body) {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!['id_person', 'refusal_id', 'signed_id', 'request_id'].every(key => typeof body[key] === 'string' && uuidPattern.test(body[key]))
        || typeof body.expected_consent_token !== 'string' || !/^[a-f0-9]{64}$/.test(body.expected_consent_token)
        || reason.length < 10 || reason.length > 500)
        return reply(400, 'INVALID_CONSENT_SUBSTITUTION', 'Selecciona los dos documentos, revisa su estado y escribe un motivo de 10 a 500 caracteres.');
    if (!await permissions.hasPermission(body.id_login, 'documents.sign', { enabledCatalog: true }))
        return reply(403, 'PERMISSION_DENIED', 'Solo el doctor responsable habilitado puede autorizar la sustitución.');
    const transaction = await sequelize.transaction();
    const reject = async response => { await transaction.rollback(); return response; };
    try {
        const patient = await lockPatient(body.id_person, body.id_business, transaction);
        if (!patient) return reject(reply(404, 'PATIENT_NOT_FOUND', 'Paciente no disponible.'));
        if (Number(patient.active) !== 1) return reject(reply(409, 'PATIENT_ARCHIVED', 'Restaura el paciente antes de autorizar una sustitución.'));
        const state = await load(body.id_person, body.id_business, transaction);
        const signed = state.documents.find(row => row.id_patient_document === body.signed_id);
        const refusal = state.documents.find(row => row.id_patient_document === body.refusal_id);
        const access = await authority(body, transaction);
        if (!access.view || !signed || !canAuthorize(access, signed, body.id_login))
            return reject(reply(403, 'PERMISSION_DENIED', 'Solo el doctor responsable habilitado puede autorizar la sustitución.'));
        // Request IDs are scoped to this patient + business, serialized by its row lock.
        const priorEvents = state.events.filter(event => domain.parsePair(event)?.q === body.request_id);
        if (priorEvents.length) {
            const prior = state.pairs.find(pair => pair.q === body.request_id);
            if (priorEvents.length !== 2 || !prior || prior.a !== body.id_login || prior.r !== body.refusal_id
                || prior.s !== body.signed_id || prior.n !== reason)
                return reject(reply(409, 'CONSENT_REQUEST_CONFLICT', 'Esta solicitud ya se utilizó con otra revisión.'));
            await transaction.commit();
            return { status: 200, data: { idempotent: true, ...preview(state, access, body.id_login) }, message: 'La autorización ya estaba registrada.' };
        }
        if (body.expected_consent_token !== reviewToken(state, access, body.id_login)) return reject(conflict());
        if (!domain.eligible(refusal, signed, state.events) || !state.remainingRefusals.includes(refusal))
            return reject(reply(409, 'CONSENT_SUBSTITUTION_INELIGIBLE', 'La negativa no puede sustituirse con este documento. Revisa las fechas y el estado actual.'));
        const payload = domain.pairPayload(refusal, signed, state.events, body.id_login,
            access.profile.id_doctor_professional_profile, body.request_id, reason, access.profile.professional_name);
        const notes = JSON.stringify(payload);
        if ([...notes].length > 1000) return reject(reply(400, 'CONSENT_REASON_TOO_LONG', 'Acorta el motivo para conservar completa la referencia de auditoría.'));
        for (const [document, event] of [[body.refusal_id, 'REFUSAL_SUPERSEDED'], [body.signed_id, 'SUPERSEDES_REFUSAL']]) {
            await sequelize.query(`INSERT INTO patient_document_events
                (id_patient_document_event, id_patient_document, id_business, event_type, notes, created_at, created_by)
                VALUES (:id, :document, :business, :event, :notes, NOW(), :actor)`,
            { replacements: { id: uuid(), document, business: body.id_business, event, notes, actor: body.id_login }, transaction, type: QueryTypes.INSERT });
        }
        const updated = await load(body.id_person, body.id_business, transaction);
        await transaction.commit();
        return { status: 200, data: { idempotent: false, ...preview(updated, access, body.id_login) }, message: 'Sustitución autorizada. Las historias anteriores se conservan.' };
    } catch (error) { if (!transaction.finished) await transaction.rollback(); throw error; }
}

module.exports = { lockPatient, lockDocumentPatient, load, review, substitute, conflict };

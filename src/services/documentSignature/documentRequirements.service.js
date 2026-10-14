const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');

// An internal, append-only event stores the requirements alongside the created
// document. Existing schemas already support this bounded, versioned metadata.
const EVENT = 'SIGNATURE_REQUIREMENTS_SNAPSHOT';
const FIELDS = ['requires_patient_signature', 'requires_tutor_signature', 'requires_doctor_signature',
    'requires_witness1_signature', 'requires_witness2_signature'];
function serialize(template) {
    const requirements = Object.fromEntries(FIELDS.map(field => [field,
        ['requires_patient_signature', 'requires_doctor_signature'].includes(field)
            ? (template[field] === 0 || template[field] === false ? 0 : 1)
            : (template[field] === 1 || template[field] === true ? 1 : 0)]));
    return JSON.stringify({ version: 1, requirements });
}
function parse(notes) {
    const snapshot = JSON.parse(notes);
    if (!snapshot || snapshot.version !== 1 || !snapshot.requirements ||
        !FIELDS.every(field => [0, 1].includes(snapshot.requirements[field]))) {
        throw new Error('No se pudieron verificar los requisitos originales de firma del documento.');
    }
    return Object.fromEntries(FIELDS.map(field => [field, snapshot.requirements[field]]));
}
async function decorateMany(documents, idBusiness, transaction = null) {
    const ids = documents.filter(d => !(d.origin === 'TREATMENT_PLAN' && d.treatment_plan_id))
        .map(d => d.id_patient_document);
    if (!ids.length) return documents;
    const events = await sequelize.query(`SELECT id_patient_document, notes FROM patient_document_events
        WHERE id_business = :_id_business AND id_patient_document IN (:_ids)
          AND event_type = :_event_type ORDER BY created_at, id_patient_document_event`,
    { replacements: { _id_business: idBusiness, _ids: ids, _event_type: EVENT }, type: QueryTypes.SELECT, transaction });
    const requirements = new Map();
    for (const event of events) {
        // There is exactly one server-created snapshot. Unexpected duplicates or
        // invalid metadata cannot silently weaken the original requirements.
        if (requirements.has(event.id_patient_document)) throw new Error('Los requisitos de firma del documento requieren revision.');
        requirements.set(event.id_patient_document, parse(event.notes));
    }
    // Legacy documents have no recoverable snapshot: preserve their existing
    // contract without manufacturing historical requirements from current data.
    return documents.map(document => ({ ...document, ...(requirements.get(document.id_patient_document) || {}) }));
}
async function decorate(document, idBusiness, transaction = null) {
    return document ? (await decorateMany([document], idBusiness, transaction))[0] : null;
}
module.exports = { EVENT, serialize, decorateMany, decorate };

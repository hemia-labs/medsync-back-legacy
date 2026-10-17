const FIELDS = Object.freeze({ reason: 500, current_condition: 1500, evolution_time: 100, main_symptoms: 1500 });

function parseSnapshot(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
    catch (_) { return {}; }
}

function projectConsultation(value) {
    const consultation = parseSnapshot(value).consultation || {};
    return Object.fromEntries(Object.keys(FIELDS).map(key => [key, typeof consultation[key] === 'string' ? consultation[key] : '']));
}

function validateConsultation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Captura inicial invalida.';
    if (Object.keys(value).some(key => !Object.prototype.hasOwnProperty.call(FIELDS, key))) return 'La captura inicial solo permite motivo y relato del paciente.';
    for (const [key, max] of Object.entries(FIELDS)) {
        if (Object.prototype.hasOwnProperty.call(value, key) && (typeof value[key] !== 'string' || value[key].length > max)) return `Valor invalido o demasiado largo: ${key}.`;
    }
    return null;
}

function mergeConsultation(snapshot, consultation) {
    const original = parseSnapshot(snapshot);
    return { ...original, consultation: { ...(original.consultation || {}), ...consultation } };
}

function intakeFields(template) {
    const schema = parseSnapshot(template);
    if (!Array.isArray(schema.sections)) return Object.keys(FIELDS);
    const consultation = schema.sections.find(section => section.key === 'consultation' && section.enabled !== false);
    if (!consultation) return [];
    return (consultation.fields || []).filter(field => Object.hasOwn(FIELDS, field.key) && field.enabled !== false && ['text', 'textarea'].includes(field.type || 'text')).map(field => field.key);
}

function projectIntake(history, patient, template = null) {
    const draft = history && history.status === 'DRAFT';
    const fields = intakeFields(history ? history.template_snapshot_json : template);
    const consultation = draft ? projectConsultation(history.clinical_snapshot_json) : projectConsultation(null);
    return { patient: { id_person: patient.id_person, full_name: patient.full_name, birthday: patient.birthday, age: patient.age },
        history: history ? { id_clinical_history: history.id_clinical_history, status: history.status,
            revision: Number(history.revision == null ? 0 : history.revision), updated_at: history.updated_at } : null,
        fields,
        consultation: Object.fromEntries(fields.map(field => [field, consultation[field]])),
        editable: (!history || draft) && fields.length > 0,
        message: history && !draft ? 'La historia ya esta cerrada. El doctor debe iniciar una nueva version para continuar la captura.'
            : !fields.length ? 'El formato de historia no incluye campos habilitados para captura inicial. El doctor puede revisar el formato del consultorio.' : null };
}

module.exports = { FIELDS, parseSnapshot, projectConsultation, validateConsultation, mergeConsultation, projectIntake, intakeFields };

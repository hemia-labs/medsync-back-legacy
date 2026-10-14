const STATUS = { UNREVIEWED: 'UNREVIEWED', HAS_ALLERGIES: 'HAS_ALLERGIES', NONE_KNOWN: 'NONE_KNOWN', UNKNOWN: 'UNKNOWN' };
const LABELS = { UNREVIEWED: 'Alergias sin revisar', HAS_ALLERGIES: 'Con alergias registradas', NONE_KNOWN: 'Sin alergias conocidas', UNKNOWN: 'No se pudo confirmar' };

function hydrateAllergy(row = {}) {
    const status = Object.values(STATUS).includes(row.review_status) ? row.review_status
        : row.has_allergy === true || row.has_allergy === 1 ? STATUS.HAS_ALLERGIES
        : row.has_allergy === false || row.has_allergy === 0 ? STATUS.NONE_KNOWN : STATUS.UNREVIEWED;
    return { ...row, review_status: status, revision: Number(row.revision || 0), description: row.description || '' };
}

function validateReview(value) {
    if (!value || ![STATUS.HAS_ALLERGIES, STATUS.NONE_KNOWN, STATUS.UNKNOWN].includes(value.review_status)) return 'Selecciona un estado de alergias.';
    if (typeof value.description !== 'string' || value.description.length > 5000) return 'El detalle debe tener como maximo 5000 caracteres.';
    if (value.review_status !== STATUS.NONE_KNOWN && !value.description.trim()) return value.review_status === STATUS.UNKNOWN ? 'Indica por que no se pudo confirmar.' : 'Describe las alergias y los detalles conocidos.';
    if (!Number.isInteger(value.expected_revision) || value.expected_revision < 0) return 'Recarga el estado de alergias antes de guardar.';
    return '';
}

function applyCurrentAllergy(snapshot, record) {
    const next = JSON.parse(JSON.stringify(snapshot || {}));
    const previous = next.allergies_medications || {};
    const current = hydrateAllergy(record);
    const legacy = previous.legacy_allergies || (!previous.allergy_status ? previous.allergies : '') || '';
    next.allergies_medications = { ...previous, allergy_status: current.review_status === STATUS.UNREVIEWED ? '' : current.review_status,
        allergies: current.review_status === STATUS.HAS_ALLERGIES ? current.description
            : current.review_status === STATUS.NONE_KNOWN ? 'Sin alergias conocidas.'
            : current.review_status === STATUS.UNKNOWN ? `No se pudo confirmar: ${current.description}` : '',
        allergy_revision: current.revision, allergy_reviewed_at: current.reviewed_at || null,
        allergy_reviewed_by: current.reviewed_by || null, legacy_allergies: legacy };
    return next;
}

function protectAllergyCore(schema) {
    const { baseClinicalHistoryTemplate } = require('./clinicalHistoryBaseTemplate');
    const copy = JSON.parse(JSON.stringify(schema && Array.isArray(schema.sections) && schema.sections.length ? schema : baseClinicalHistoryTemplate));
    if (!Array.isArray(copy.sections)) copy.sections = [];
    let section = copy.sections.find(s => s.key === 'allergies_medications');
    if (!section) { section = { key: 'allergies_medications', label: 'Alergias y medicamentos actuales', enabled: true, order: 6, fields: [] }; copy.sections.push(section); }
    section.enabled = true; section.locked = true; section.system = true;
    const statusField = (section.fields || []).find(f => f.key === 'allergy_status') || {};
    section.fields = (section.fields || []).filter(f => f.key !== 'allergy_status');
    let details = section.fields.find(f => f.key === 'allergies');
    if (!details) { details = { key: 'allergies', label: 'Alergias y detalles conocidos' }; section.fields.unshift(details); }
    details.type = 'textarea'; details.required = false; details.system_core = true; details.enabled = true;
    section.fields.unshift({ ...statusField, key: 'allergy_status', label: statusField.label || 'Estado de alergias', type: 'select', required: true, enabled: true, system_core: true,
        options: [STATUS.HAS_ALLERGIES, STATUS.NONE_KNOWN, STATUS.UNKNOWN] });
    return copy;
}

module.exports = { STATUS, LABELS, hydrateAllergy, validateReview, applyCurrentAllergy, protectAllergyCore };

const STATUSES = ['pending', 'in_progress', 'paused', 'completed', 'cancelled'];
const dateValid = value => {
    if (!value) return true;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const text = (value, max, required = false) => typeof value === 'string'
    && (!required || Boolean(value.trim())) && [...value].length <= max;
const validateTreatment = body => {
    const errors = {};
    if (!text(body.name, 255, true)) errors.name = 'Escribe un nombre de tratamiento de hasta 255 caracteres.';
    if (body.category && !text(body.category, 120)) errors.category = 'La categoría admite hasta 120 caracteres.';
    for (const key of ['description', 'notes']) {
        if (body[key] && (typeof body[key] !== 'string' || Buffer.byteLength(body[key], 'utf8') > 65535)) errors[key] = 'El texto supera el tamaño permitido.';
    }
    if (body.cost !== '' && body.cost !== undefined && body.cost !== null &&
        (!['string', 'number'].includes(typeof body.cost) || !/^\d+(\.\d{1,2})?$/.test(String(body.cost)) || !Number.isFinite(Number(body.cost)) || Number(body.cost) >= 1e16)) {
        errors.cost = 'Usa un costo no negativo con hasta dos decimales.';
    }
    for (const key of ['estimated_start_date', 'estimated_end_date']) {
        if (!dateValid(body[key])) errors[key] = 'Usa una fecha válida.';
    }
    if (body.estimated_start_date && body.estimated_end_date && body.estimated_end_date < body.estimated_start_date) errors.estimated_end_date = 'El fin no puede ser anterior al inicio.';
    if (body.status && !STATUSES.includes(body.status)) errors.status = 'Selecciona un estado válido.';
    if (body.teeth !== undefined && (!Array.isArray(body.teeth) || body.teeth.length > 52 || body.teeth.some(tooth => !/^(?:[1-4][1-8]|[5-8][1-5])$/.test(String(tooth))))) errors.teeth = 'Selecciona hasta 52 dientes permanentes o temporales válidos.';
    if (body.tooth_details !== undefined && (!Array.isArray(body.tooth_details) || body.tooth_details.length > 52 || Buffer.byteLength(JSON.stringify(body.tooth_details), 'utf8') > 131072)) errors.tooth_details = 'Detalles dentales inválidos o demasiado grandes.';
    return errors;
};
const validatePlan = body => {
    const errors = {};
    if (!text(body.title, 255, true)) errors.title = 'Escribe un nombre del plan de hasta 255 caracteres.';
    if (body.diagnosis && !text(body.diagnosis, 1000)) errors.diagnosis = 'El diagnóstico admite hasta 1000 caracteres.';
    if (body.notes && (typeof body.notes !== 'string' || Buffer.byteLength(body.notes, 'utf8') > 65535)) errors.notes = 'Las notas superan el tamaño permitido.';
    if (!dateValid(body.started_at)) errors.started_at = 'Usa una fecha de inicio válida.';
    return errors;
};
module.exports = { STATUSES, validateTreatment, validatePlan, dateValid };

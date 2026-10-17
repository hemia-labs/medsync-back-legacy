const { invalid, valid, requireField } = require('./common.validator');

const isEmpty = (value) => value === undefined || value === null || value === '';

const validateList = (req) => {
    const query = req.query || {};
    for(const [key, label] of [['date_from', 'Desde'], ['date_to', 'Hasta']]) {
        const value = query[key];
        if(isEmpty(value)) continue;
        if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid(`La fecha ${label} debe ser una fecha válida con formato AAAA-MM-DD.`);
        const date = new Date(`${value}T00:00:00.000Z`);
        if(Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return invalid(`La fecha ${label} no es una fecha válida.`);
    }
    if(query.date_from && query.date_to && query.date_from > query.date_to) return invalid('La fecha Hasta debe ser igual o posterior a Desde. Corrige el rango para buscar recetas.');
    return valid();
};

const validateConfigSave = (req) => {
    const body = req.body || {};
    const validModes = ['header', 'background'];

    if (body.template_mode && !validModes.includes(body.template_mode)) {
        return invalid('Modo de plantilla invalido.');
    }

    return valid();
};

const validatePrescriptionSave = (req) => {
    const payload = (req.body && (req.body.prescription || req.body)) || {};

    let result = requireField(payload, 'id_person');
    if (!result.isValid) {
        return result;
    }

    result = requireField(payload, 'issuer_doctor_id');
    if (!result.isValid) {
        return invalid('Campo requerido: doctor emisor');
    }

    if (payload.status && !['draft'].includes(payload.status)) {
        return invalid('Solo se pueden guardar borradores desde este endpoint.');
    }

    if (payload.items !== undefined && !Array.isArray(payload.items)) {
        return invalid('Campo invalido: items');
    }

    if (payload.create_request_id != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.create_request_id)) {
        return invalid('Identificador de captura de receta invalido.');
    }

    return valid();
};

const validateIssue = (req) => {
    const body = req.body || {};
    const result = requireField(body, 'id_prescription');
    if (!result.isValid) {
        return result;
    }

    return valid();
};

const validateCancel = (req) => {
    const body = req.body || {};

    let result = requireField(body, 'id_prescription');
    if (!result.isValid) {
        return result;
    }

    if (isEmpty(body.reason) && isEmpty(body.cancellation_reason)) {
        return invalid('Campo requerido: motivo de cancelacion');
    }

    return valid();
};

const validateDeleteDraft = (req) => {
    const body = req.body || {};
    return requireField(body, 'id_prescription');
};

const validateAuditAction = (req) => {
    const body = req.body || {};

    let result = requireField(body, 'id_prescription');
    if (!result.isValid) {
        return result;
    }

    result = requireField(body, 'action');
    if (!result.isValid) {
        return result;
    }

    if (!['printed', 'downloaded', 'pdf_generated'].includes(body.action)) {
        return invalid('Accion de auditoria invalida.');
    }

    return valid();
};

module.exports = {
    validateList,
    validateConfigSave,
    validatePrescriptionSave,
    validateIssue,
    validateCancel,
    validateDeleteDraft,
    validateAuditAction
};

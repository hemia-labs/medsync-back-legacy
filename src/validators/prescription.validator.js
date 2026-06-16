const { invalid, valid, requireField } = require('./common.validator');

const isEmpty = (value) => value === undefined || value === null || value === '';

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
    validateConfigSave,
    validatePrescriptionSave,
    validateIssue,
    validateCancel,
    validateDeleteDraft,
    validateAuditAction
};

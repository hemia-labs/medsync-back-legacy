const { invalid, valid, requireField } = require('./common.validator');

const VALID_SOURCES = ['MANUAL', 'LEGACY_PATIENT_DATA'];

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const isValidJsonString = (value) => {
    if (typeof value !== 'string') {
        return false;
    }

    try {
        const parsed = JSON.parse(value);
        return isObject(parsed);
    } catch (error) {
        return false;
    }
};

const hasValidSnapshot = (payload) => (
    isObject(payload.clinical_snapshot_json) || isValidJsonString(payload.clinical_snapshot_json)
);

const validatePatientParam = (req) => {
    if (!req.params || !req.params.patientId) {
        return invalid('Campo requerido: patientId');
    }

    return valid();
};

const validateIdParam = (req) => {
    if (!req.params || !req.params.id) {
        return invalid('Campo requerido: id');
    }

    return valid();
};

const validateDraftCreate = (req) => {
    const body = req.body || {};

    let result = requireField(body, 'patient_id');
    if (!result.isValid) {
        return result;
    }

    result = requireField(body, 'clinical_snapshot_json');
    if (!result.isValid) {
        return result;
    }

    if (!hasValidSnapshot(body)) {
        return invalid('Campo invalido: clinical_snapshot_json');
    }

    if (body.source && !VALID_SOURCES.includes(body.source)) {
        return invalid('Origen de historia clinica invalido.');
    }

    return valid();
};

const validateDraftUpdate = (req) => {
    const idResult = validateIdParam(req);
    if (!idResult.isValid) {
        return idResult;
    }

    const body = req.body || {};
    const result = requireField(body, 'clinical_snapshot_json');
    if (!result.isValid) {
        return result;
    }

    if (!hasValidSnapshot(body)) {
        return invalid('Campo invalido: clinical_snapshot_json');
    }

    return valid();
};

module.exports = {
    validatePatientParam,
    validateIdParam,
    validateDraftCreate,
    validateDraftUpdate
};

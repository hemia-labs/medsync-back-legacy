const { invalid, valid, requireField } = require('./common.validator');
const { validateVitalSigns } = require('../domain/clinicalHistory/vitalSignsValidation');

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
const snapshotValidation = body => {
    if (!hasValidSnapshot(body)) return invalid('Campo invalido: clinical_snapshot_json');
    const snapshot = typeof body.clinical_snapshot_json === 'string' ? JSON.parse(body.clinical_snapshot_json) : body.clinical_snapshot_json;
    const error = validateVitalSigns(snapshot);
    return error ? invalid(error) : valid();
};

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

    const snapshot = snapshotValidation(body);
    if (!snapshot.isValid) return snapshot;

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

    return snapshotValidation(body);
};

module.exports = {
    validatePatientParam,
    validateIdParam,
    validateDraftCreate,
    validateDraftUpdate
};

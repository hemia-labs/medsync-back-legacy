const {
    requireArray,
    requireField,
    requireFields,
    valid
} = require('./common.validator');

const validateIdPersonParam = (req) => {
    return requireField(req.params, 'id_person');
};

const validateGetTooth = (req) => {
    return requireFields(req.params, ['id_person', 'id_tooth']);
};

const validateSaveTooth = (req) => {
    const result = requireFields(req.body, ['id_person', 'id_tooth', 'symbol', 'observation']);
    if (!result.isValid) {
        return result;
    }

    return requireArray(req.body, 'config');
};

const validateUpdateTooth = (req) => {
    const result = requireFields(req.body, ['id_odontogram', 'id_person', 'id_tooth', 'symbol', 'observation']);
    if (!result.isValid) {
        return result;
    }

    return requireArray(req.body, 'config');
};

const validateSaveOdontogram = (req) => {
    return requireFields(req.body, ['id_person', 'type']);
};

const validateSaveOdontogramDetail = (req) => {
    return requireFields(req.body, ['id_person', 'id_tooth', 'treatment']);
};

const validateStatusOdontogram = (req) => {
    const result = requireField(req.body, 'id_odontogramv1');
    if (!result.isValid) {
        return result;
    }

    if (typeof req.body.active !== 'boolean') {
        return {
            isValid: false,
            message: 'Campo invalido: active'
        };
    }

    return valid();
};

const validateDeleteOdontogram = (req) => {
    return requireField(req.body, 'id_odontogramv1');
};

module.exports = {
    validateDeleteOdontogram,
    validateGetTooth,
    validateIdPersonParam,
    validateSaveOdontogram,
    validateSaveOdontogramDetail,
    validateSaveTooth,
    validateStatusOdontogram,
    validateUpdateTooth
};

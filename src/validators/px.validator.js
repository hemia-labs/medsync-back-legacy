const {
    requireField,
    requireFields,
    requireObject,
    valid
} = require('./common.validator');

const validatePerson = (person, isUpdate = false) => {
    const fields = [
        'name',
        'surname',
        'birthday',
        'age',
        'ocupation',
        'telephone'
    ];

    if (isUpdate) {
        fields.unshift('id_person');
    }

    return requireFields(person, fields);
};

const validateMinimalPerson = (person) => {
    const fields = [
        'name',
        'surname',
        'birthday',
        'age',
        'telephone'
    ];

    return requireFields(person, fields);
};

const validateAddress = (address, isUpdate = false) => {
    const fields = ['place_birth', 'residence', 'direction', 'cp'];
    if (isUpdate) {
        fields.unshift('id_address');
    }

    return requireFields(address, fields);
};

const validateQuery = (query, isUpdate = false) => {
    const fields = [
        'reason_consultation',
        'current_condition'
    ];

    if (isUpdate) {
        fields.unshift('id_query');
    }

    return requireFields(query, fields);
};

const validateAllergy = (allergy, isUpdate = false) => {
    const fields = ['has_allergy'];
    if (isUpdate) {
        fields.unshift('id_allergy');
    }

    return requireFields(allergy, fields);
};

const validatePxPayload = (req, isUpdate = false) => {
    for (const field of ['person', 'address', 'query', 'allergy']) {
        const result = requireObject(req.body, field);
        if (!result.isValid) {
            return result;
        }
    }

    const validators = [
        validatePerson(req.body.person, isUpdate),
        validateAddress(req.body.address, isUpdate),
        validateQuery(req.body.query, isUpdate),
        validateAllergy(req.body.allergy, isUpdate)
    ];

    return validators.find((result) => !result.isValid) || valid();
};

const validatePxSave = (req) => {
    return validatePxPayload(req);
};

const validatePxCreateMinimal = (req) => {
    const personResult = requireObject(req.body, 'person');
    if (!personResult.isValid) {
        return personResult;
    }

    return validateMinimalPerson(req.body.person);
};

const validatePxUpdate = (req) => {
    return validatePxPayload(req, true);
};

const validatePxDelete = (req) => {
    return requireField(req.body, 'id_person');
};

const validatePxSearch = (req) => {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'param')) {
        return valid();
    }

    return requireField(req.body, 'param');
};

const validatePxFastSearch = (req) => {
    if (req.body && (
        Object.prototype.hasOwnProperty.call(req.body, 'query')
        || Object.prototype.hasOwnProperty.call(req.body, 'param')
    )) {
        return valid();
    }

    return requireField(req.body, 'query');
};

const validatePxIdParam = (req) => {
    return requireField(req.params, 'id');
};

module.exports = {
    validatePxDelete,
    validatePxFastSearch,
    validatePxIdParam,
    validatePxCreateMinimal,
    validatePxSave,
    validatePxSearch,
    validatePxUpdate
};

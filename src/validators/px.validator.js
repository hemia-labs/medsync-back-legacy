const {
    requireField,
    requireFields,
    requireObject,
    invalid,
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
    // Patient details updates no longer change the independently reviewed allergy record.
    if (isUpdate || allergy.review_status === 'UNREVIEWED' || allergy.review_status === 'UNKNOWN') return valid();
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

const validatePxAdministrative = (req) => {
    for (const field of ['person', 'address']) {
        const result = requireObject(req.body, field);
        if (!result.isValid) return result;
    }
    const person = req.body.person;
    const required = requireFields(person, ['id_person', 'name', 'surname', 'birthday', 'age', 'telephone']);
    if (!required.isValid) return required;
    for (const field of ['id_person', 'name', 'surname', 'birthday', 'telephone']) {
        if (typeof person[field] !== 'string' || !person[field].trim() || person[field].length > 500) return invalid(`Campo invalido: ${field}`);
    }
    if (person.id_person.length > 50 || !/^\d{4}-\d{2}-\d{2}$/.test(person.birthday)) return invalid('Fecha de nacimiento o paciente invalido.');
    const birth = new Date(`${person.birthday}T00:00:00Z`);
    if (!Number.isFinite(birth.getTime()) || birth.toISOString().slice(0, 10) !== person.birthday || birth > new Date()) return invalid('Fecha de nacimiento invalida.');
    if (!Number.isInteger(Number(person.age)) || Number(person.age) < 0 || Number(person.age) > 150) return invalid('Edad invalida.');
    for (const object of [person, req.body.address]) {
        for (const field of ['ocupation', 'rfc', 'local_telephone', 'place_birth', 'residence', 'direction', 'cp']) {
            if (object[field] != null && (typeof object[field] !== 'string' || object[field].length > 1000)) return invalid(`Campo invalido: ${field}`);
        }
    }
    return valid();
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
    validatePxAdministrative,
    validatePxDelete,
    validatePxFastSearch,
    validatePxIdParam,
    validatePxCreateMinimal,
    validatePxSave,
    validatePxSearch,
    validatePxUpdate
};

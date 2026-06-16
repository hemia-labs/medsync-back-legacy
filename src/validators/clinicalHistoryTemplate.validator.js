const { invalid, valid, requireField } = require('./common.validator');

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const isValidSchema = (value) => {
    if (isObject(value)) {
        return true;
    }

    if (typeof value !== 'string') {
        return false;
    }

    try {
        return isObject(JSON.parse(value));
    } catch (error) {
        return false;
    }
};

const validateTemplateIdParam = (req) => {
    if (!req.params || !req.params.templateId) {
        return invalid('Campo requerido: templateId');
    }

    return valid();
};

const validateCreateBusinessTemplate = (req) => {
    const body = req.body || {};
    if (body.name !== undefined && String(body.name).trim().length > 160) {
        return invalid('Campo inválido: name');
    }

    if (body.description !== undefined && String(body.description).trim().length > 500) {
        return invalid('Campo inválido: description');
    }

    return valid();
};

const validateCreateVersion = (req) => {
    const paramResult = validateTemplateIdParam(req);
    if (!paramResult.isValid) {
        return paramResult;
    }

    const body = req.body || {};
    const schemaResult = requireField(body, 'schema_json');
    if (!schemaResult.isValid) {
        return schemaResult;
    }

    if (!isValidSchema(body.schema_json)) {
        return invalid('Campo inválido: schema_json');
    }

    if (body.name !== undefined && String(body.name).trim().length > 160) {
        return invalid('Campo inválido: name');
    }

    if (body.description !== undefined && String(body.description).trim().length > 500) {
        return invalid('Campo inválido: description');
    }

    return valid();
};

module.exports = {
    validateCreateBusinessTemplate,
    validateCreateVersion
};

const VALID_IMAGE_TYPES = ['jpeg', 'jpg', 'png', 'webp'];

const invalid = (message) => ({
    isValid: false,
    message
});

const valid = () => ({
    isValid: true,
    message: ''
});

const isEmpty = (value) => value === undefined || value === null || value === '';

const requireField = (payload, field) => {
    if (!payload || isEmpty(payload[field])) {
        return invalid(`Campo requerido: ${field}`);
    }

    return valid();
};

const requireFields = (payload, fields) => {
    for (const field of fields) {
        const result = requireField(payload, field);
        if (!result.isValid) {
            return result;
        }
    }

    return valid();
};

const requireArray = (payload, field) => {
    const result = requireField(payload, field);
    if (!result.isValid) {
        return result;
    }

    if (!Array.isArray(payload[field])) {
        return invalid(`Campo invalido: ${field}`);
    }

    return valid();
};

const requireObject = (payload, field) => {
    const result = requireField(payload, field);
    if (!result.isValid) {
        return result;
    }

    if (typeof payload[field] !== 'object' || Array.isArray(payload[field])) {
        return invalid(`Campo invalido: ${field}`);
    }

    return valid();
};

const requireImageDataUrl = (payload, field) => {
    const result = requireField(payload, field);
    if (!result.isValid) {
        return result;
    }

    const value = payload[field];
    if (typeof value !== 'string') {
        return invalid(`Campo invalido: ${field}`);
    }

    const match = value.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,/);
    if (!match) {
        return invalid(`Formato de imagen invalido: ${field}`);
    }

    const type = match[1].toLowerCase();
    if (!VALID_IMAGE_TYPES.includes(type)) {
        return invalid(`Tipo de imagen no permitido: ${field}`);
    }

    return valid();
};

module.exports = {
    invalid,
    valid,
    requireField,
    requireFields,
    requireArray,
    requireObject,
    requireImageDataUrl
};

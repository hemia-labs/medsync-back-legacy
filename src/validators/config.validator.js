const { requireImageDataUrl, valid, invalid } = require('./common.validator');

const MAX_LOGIN_IMAGE_BYTES = 2 * 1024 * 1024;

const getBase64Size = (value) => {
    const base64 = value.split(',')[1] || '';
    const padding = (base64.match(/=*$/) || [''])[0].length;
    return Math.floor((base64.length * 3) / 4) - padding;
};

const validateLoginImageSave = (req) => {
    const result = requireImageDataUrl(req.body, 'image_data');
    if (!result.isValid) {
        return result;
    }

    if (getBase64Size(req.body.image_data) > MAX_LOGIN_IMAGE_BYTES) {
        return invalid('La imagen de login no debe superar 2 MB.');
    }

    return valid();
};

const validateThemeSave = (req) => {
    const value = req.body && req.body.code;
    if (!value || typeof value !== 'string') {
        return invalid('Campo requerido: code');
    }

    if (!/^[a-z0-9-]+$/i.test(value)) {
        return invalid('Campo invalido: code');
    }

    return valid();
};

module.exports = {
    validateLoginImageSave,
    validateThemeSave
};

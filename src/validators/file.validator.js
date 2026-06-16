const {
    requireField,
    requireFields,
    requireImageDataUrl,
    valid
} = require('./common.validator');

const validateGetFiles = (req) => {
    return requireField(req.params, 'px');
};

const validateUploadFile = (req) => {
    const fieldsResult = requireFields(req.body, ['code_cat_files', 'id_person']);
    if (!fieldsResult.isValid) {
        return fieldsResult;
    }

    return requireImageDataUrl(req.body, 'file');
};

const validateUploadProfile = (req) => {
    const idResult = requireField(req.body, 'id_person');
    if (!idResult.isValid) {
        return idResult;
    }

    return requireImageDataUrl(req.body, 'file');
};

const validateDeleteFile = (req) => {
    const result = requireFields(req.body, ['code_cat_files', 'id_person', 'key']);
    return result.isValid ? valid() : result;
};

module.exports = {
    validateDeleteFile,
    validateGetFiles,
    validateUploadFile,
    validateUploadProfile
};

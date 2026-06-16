const {
    requireArray,
    requireField,
    requireFields,
    valid
} = require('./common.validator');

const validateIdPersonParam = (req) => {
    return requireField(req.params, 'id_person');
};

const validateTreatmentItems = (body, requireIdTreatment = false) => {
    const arrayResult = requireArray(body, 'treatment');
    if (!arrayResult.isValid) {
        return arrayResult;
    }

    if (body.treatment.length <= 0) {
        return {
            isValid: false,
            message: 'Campo requerido: treatment'
        };
    }

    for (const item of body.treatment) {
        const fields = requireIdTreatment
            ? ['id_treatment', 'description', 'amount']
            : ['description', 'amount'];

        const result = requireFields(item, fields);
        if (!result.isValid) {
            return result;
        }
    }

    return valid();
};

const validateSaveTreatment = (req) => {
    const idResult = requireField(req.body, 'id_person');
    if (!idResult.isValid) {
        return idResult;
    }

    return validateTreatmentItems(req.body);
};

const validateUpdateTreatment = (req) => {
    const idResult = requireField(req.body, 'id_person');
    if (!idResult.isValid) {
        return idResult;
    }

    return validateTreatmentItems(req.body, true);
};

const validateDeleteTreatment = (req) => {
    return requireFields(req.body, ['id_treatment', 'id_person']);
};

const validateSaveDiagnosis = (req) => {
    return requireFields(req.body, [
        'id_diagnosis',
        'id_odontogram',
        'id_person',
        'treatment',
        'amount'
    ]);
};

const validateCreateTreatmentPlan = (req) => {
    return requireField(req.body, 'id_person');
};

const validateCloseTreatmentPlan = (req) => {
    return requireFields(req.body, ['id_person', 'id_treatment_plan']);
};

const validateSavePlanTreatment = (req) => {
    return requireFields(req.body, ['id_person', 'name']);
};

const validateUpdatePlanTreatmentStatus = (req) => {
    return requireFields(req.body, ['id_person', 'id_patient_treatment', 'status']);
};

const validateDeletePlanTreatment = (req) => {
    return requireFields(req.body, ['id_person', 'id_patient_treatment']);
};

const validateSavePlanConsent = (req) => {
    return requireFields(req.body, ['id_person', 'id_treatment_plan', 'patient_signature']);
};

module.exports = {
    validateCloseTreatmentPlan,
    validateCreateTreatmentPlan,
    validateDeleteTreatment,
    validateDeletePlanTreatment,
    validateIdPersonParam,
    validateSaveDiagnosis,
    validateSavePlanConsent,
    validateSavePlanTreatment,
    validateSaveTreatment,
    validateUpdatePlanTreatmentStatus,
    validateUpdateTreatment
};

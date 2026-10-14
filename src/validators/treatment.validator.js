const {
    requireArray,
    requireField,
    requireFields,
    valid
} = require('./common.validator');
const { STATUSES, validateTreatment, validatePlan } = require('../util/treatmentPlanValidation');
const validateFields = errors => Object.keys(errors).length
    ? { isValid: false, message: Object.values(errors)[0] } : valid();

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
    const required = requireField(req.body, 'id_person');
    return required.isValid ? validateFields(validatePlan(req.body)) : required;
};

const validateUpdateTreatmentPlan = req => {
    const required = requireFields(req.body, ['id_person', 'id_treatment_plan']);
    return required.isValid ? validateFields(validatePlan(req.body)) : required;
};

const validateCloseTreatmentPlan = (req) => {
    const required = requireFields(req.body, ['id_person', 'id_treatment_plan']);
    if (!required.isValid) return required;
    if (req.body.close_reason && (typeof req.body.close_reason !== 'string' || [...req.body.close_reason].length > 1000)) return { isValid: false, message: 'El motivo de cierre admite hasta 1000 caracteres.' };
    return valid();
};

const validateSavePlanTreatment = (req) => {
    const required = requireFields(req.body, ['id_person', 'name']);
    return required.isValid ? validateFields(validateTreatment(req.body)) : required;
};

const validateUpdatePlanTreatmentStatus = (req) => {
    const required = requireFields(req.body, ['id_person', 'id_patient_treatment', 'status']);
    return required.isValid && !STATUSES.includes(req.body.status)
        ? { isValid: false, message: 'Selecciona un estado válido.' } : required;
};

const validateDeletePlanTreatment = (req) => {
    return requireFields(req.body, ['id_person', 'id_patient_treatment']);
};

const validateSavePlanConsent = (req) => {
    const required = requireFields(req.body, ['id_person', 'id_treatment_plan', 'patient_signature', 'doctor_user_id', 'request_id']);
    if (!required.isValid) return required;
    if (!/^[a-zA-Z0-9-]{1,50}$/.test(req.body.request_id)) return { isValid: false, message: 'Identificador de guardado inválido.' };
    if (typeof req.body.patient_signature !== 'string' || !/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=]+$/.test(req.body.patient_signature) || req.body.patient_signature.length > 2000000) return { isValid: false, message: 'Aplica una firma del paciente válida.' };
    return valid();
};

const validatePreparePlanConsent = req => requireFields(req.body, ['id_person', 'id_treatment_plan', 'doctor_user_id', 'review_token']);
const validateSignPreparedConsent = req => {
    const required = requireFields(req.body, ['id_person', 'id_patient_document', 'patient_signature']);
    if (!required.isValid) return required;
    if (req.body.signature_role && !['PATIENT', 'TUTOR', 'DOCTOR', 'WITNESS1', 'WITNESS2'].includes(req.body.signature_role)) return { isValid: false, message: 'Selecciona una firma válida.' };
    if (typeof req.body.patient_signature !== 'string' || !/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=]+$/.test(req.body.patient_signature) || req.body.patient_signature.length > 2000000) return { isValid: false, message: 'Aplica una firma válida.' };
    if (req.body.signer_name && (typeof req.body.signer_name !== 'string' || req.body.signer_name.length > 255)) return { isValid: false, message: 'El nombre de quien firma admite hasta 255 caracteres.' };
    return valid();
};

module.exports = {
    validatePreparePlanConsent,
    validateSignPreparedConsent,
    validateCloseTreatmentPlan,
    validateCreateTreatmentPlan,
    validateUpdateTreatmentPlan,
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

const DOCUMENT_BLOCK_MODES = Object.freeze({
    NEVER: 'never',
    FRONTEND_ONLY: 'frontend_only',
    WARN: 'warn',
    HARD_BLOCK_CREATE_ONLY: 'hard_block_create_only',
    HARD_BLOCK_PREMIUM_ONLY: 'hard_block_premium_only',
    REQUIRES_REDESIGN: 'requires_redesign'
});

const DOCUMENT_TEMPLATE_SUBTYPES = Object.freeze({
    BASIC: 'basic',
    MANDATORY_CONSENT: 'mandatory_consent',
    CLINICAL_CONSENT: 'clinical_consent',
    TREATMENT_CONSENT: 'treatment_consent',
    CUSTOM_BASIC: 'custom_basic',
    CUSTOM_CLINICAL: 'custom_clinical',
    CUSTOM_ADVANCED: 'custom_advanced',
    CUSTOM_PREMIUM: 'custom_premium',
    PREMIUM_MULTI_SIGNATURE: 'premium_multi_signature',
    PREMIUM_WITNESSES: 'premium_witnesses',
    PREMIUM_AUTOMATION: 'premium_automation',
    UNKNOWN: 'unknown'
});

const DOCUMENT_LICENSING_CATEGORIES = Object.freeze({
    basic_document: Object.freeze({
        code: 'basic_document',
        label: 'Documento basico',
        description: 'Documento operativo no premium del expediente del paciente.',
        minimumPlan: 'basic',
        blockMode: DOCUMENT_BLOCK_MODES.NEVER,
        clinicalLegalSafe: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        canBlockDownload: false,
        canBlockAudit: false,
        recommendedFeature: null,
        notes: 'Debe mantenerse disponible para continuidad clinica.'
    }),
    mandatory_consent: Object.freeze({
        code: 'mandatory_consent',
        label: 'Consentimiento obligatorio',
        description: 'Consentimiento requerido para operacion legal o tratamiento de datos sensibles.',
        minimumPlan: 'basic',
        blockMode: DOCUMENT_BLOCK_MODES.NEVER,
        clinicalLegalSafe: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        canBlockDownload: false,
        canBlockAudit: false,
        recommendedFeature: null,
        notes: 'Nunca debe bloquearse por plan comercial.'
    }),
    clinical_consent: Object.freeze({
        code: 'clinical_consent',
        label: 'Consentimiento clinico',
        description: 'Consentimiento ligado a atencion clinica general.',
        minimumPlan: 'basic',
        blockMode: DOCUMENT_BLOCK_MODES.NEVER,
        clinicalLegalSafe: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        canBlockDownload: false,
        canBlockAudit: false,
        recommendedFeature: null,
        notes: 'Debe estar disponible en Basic.'
    }),
    advanced_document: Object.freeze({
        code: 'advanced_document',
        label: 'Documento avanzado',
        description: 'Documento no obligatorio con funcionalidad avanzada futura.',
        minimumPlan: 'pro',
        blockMode: DOCUMENT_BLOCK_MODES.HARD_BLOCK_CREATE_ONLY,
        clinicalLegalSafe: false,
        canBlockCreate: true,
        canBlockRead: false,
        canBlockSign: false,
        canBlockDownload: false,
        canBlockAudit: false,
        recommendedFeature: 'advanced_documents',
        notes: 'Solo seria candidato a bloqueo al crear/versionar, nunca sobre documentos existentes.'
    }),
    custom_document_template: Object.freeze({
        code: 'custom_document_template',
        label: 'Plantilla documental custom',
        description: 'Plantilla tipo CUSTOM sin subtipo documental normalizado.',
        minimumPlan: 'basic',
        blockMode: DOCUMENT_BLOCK_MODES.REQUIRES_REDESIGN,
        clinicalLegalSafe: false,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        canBlockDownload: false,
        canBlockAudit: false,
        recommendedFeature: 'custom_document_templates',
        notes: 'CUSTOM no se bloquea automaticamente hasta contar con subtipo o metadata adicional.'
    }),
    premium_document_template: Object.freeze({
        code: 'premium_document_template',
        label: 'Plantilla documental premium',
        description: 'Plantilla documental no obligatoria con reglas premium.',
        minimumPlan: 'enterprise',
        blockMode: DOCUMENT_BLOCK_MODES.HARD_BLOCK_PREMIUM_ONLY,
        clinicalLegalSafe: false,
        canBlockCreate: true,
        canBlockRead: false,
        canBlockSign: false,
        canBlockDownload: false,
        canBlockAudit: false,
        recommendedFeature: 'premium_document_templates',
        notes: 'Categoria preparada para fases futuras; no hay enforcement runtime en L3-C.4.'
    }),
    treatment_consent: Object.freeze({
        code: 'treatment_consent',
        label: 'Consentimiento de tratamiento',
        description: 'Consentimiento asociado a plan de tratamiento.',
        minimumPlan: 'basic',
        blockMode: DOCUMENT_BLOCK_MODES.NEVER,
        clinicalLegalSafe: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        canBlockDownload: false,
        canBlockAudit: false,
        recommendedFeature: null,
        notes: 'treatment_plan_consent y TREATMENT_PLAN_CONSENT deben estar disponibles en Basic.'
    }),
    legal_trace: Object.freeze({
        code: 'legal_trace',
        label: 'Trazabilidad legal',
        description: 'Eventos legales de firma, negativa, cancelacion y consulta.',
        minimumPlan: 'basic',
        blockMode: DOCUMENT_BLOCK_MODES.NEVER,
        clinicalLegalSafe: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        canBlockDownload: false,
        canBlockAudit: false,
        recommendedFeature: null,
        notes: 'La trazabilidad legal siempre debe mantenerse disponible.'
    }),
    document_audit: Object.freeze({
        code: 'document_audit',
        label: 'Auditoria documental',
        description: 'Registro de eventos sobre documentos existentes.',
        minimumPlan: 'basic',
        blockMode: DOCUMENT_BLOCK_MODES.NEVER,
        clinicalLegalSafe: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        canBlockDownload: false,
        canBlockAudit: false,
        recommendedFeature: null,
        notes: 'No debe bloquearse por plan.'
    })
});

const CONSENT_LICENSING_CATEGORIES = Object.freeze({
    basic_consent: Object.freeze({
        code: 'basic_consent',
        description: 'Consentimiento basico disponible para cualquier plan.',
        minimumPlan: 'basic',
        mustBeAvailableInBasic: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        clinicalLegalRisk: 'medium',
        recommendedFeature: null,
        notes: 'Categoria base para consentimiento no premium.'
    }),
    mandatory_consent: Object.freeze({
        code: 'mandatory_consent',
        description: 'Consentimiento obligatorio legal/operativo.',
        minimumPlan: 'basic',
        mustBeAvailableInBasic: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        clinicalLegalRisk: 'high',
        recommendedFeature: null,
        notes: 'Siempre disponible en Basic.'
    }),
    clinical_consent: Object.freeze({
        code: 'clinical_consent',
        description: 'Consentimiento clinico/legal de atencion.',
        minimumPlan: 'basic',
        mustBeAvailableInBasic: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        clinicalLegalRisk: 'high',
        recommendedFeature: null,
        notes: 'Siempre disponible en Basic.'
    }),
    treatment_consent: Object.freeze({
        code: 'treatment_consent',
        description: 'Consentimiento de plan de tratamiento.',
        minimumPlan: 'basic',
        mustBeAvailableInBasic: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        clinicalLegalRisk: 'high',
        recommendedFeature: null,
        notes: 'Siempre disponible en Basic.'
    }),
    advanced_consent: Object.freeze({
        code: 'advanced_consent',
        description: 'Consentimiento avanzado no obligatorio.',
        minimumPlan: 'pro',
        mustBeAvailableInBasic: false,
        canBlockCreate: true,
        canBlockRead: false,
        canBlockSign: false,
        clinicalLegalRisk: 'medium',
        recommendedFeature: 'advanced_consents',
        notes: 'Solo candidato a bloqueo futuro al crear/versionar.'
    }),
    custom_consent_template: Object.freeze({
        code: 'custom_consent_template',
        description: 'Consentimiento custom sin subtipo normalizado.',
        minimumPlan: 'basic',
        mustBeAvailableInBasic: true,
        canBlockCreate: false,
        canBlockRead: false,
        canBlockSign: false,
        clinicalLegalRisk: 'medium',
        recommendedFeature: 'custom_consent_templates',
        notes: 'No bloquear hasta separar subtipo legal/clinico/premium.'
    }),
    premium_consent_template: Object.freeze({
        code: 'premium_consent_template',
        description: 'Plantilla de consentimiento premium no obligatoria.',
        minimumPlan: 'enterprise',
        mustBeAvailableInBasic: false,
        canBlockCreate: true,
        canBlockRead: false,
        canBlockSign: false,
        clinicalLegalRisk: 'medium',
        recommendedFeature: 'premium_consent_templates',
        notes: 'Preparado para enforcement futuro granular.'
    })
});

const TEMPLATE_TYPE_TO_DOCUMENT_CATEGORY = Object.freeze({
    SENSITIVE_DATA_CONSENT: 'mandatory_consent',
    GENERAL_ATTENTION_CONSENT: 'clinical_consent',
    TREATMENT_PLAN_CONSENT: 'treatment_consent',
    CUSTOM: 'custom_document_template'
});

const CONSENT_TYPE_TO_CONSENT_CATEGORY = Object.freeze({
    SENSITIVE_DATA_CONSENT: 'mandatory_consent',
    GENERAL_ATTENTION_CONSENT: 'clinical_consent',
    TREATMENT_PLAN_CONSENT: 'treatment_consent',
    TREATMENT_PLAN: 'treatment_consent',
    SIGNATURE_CONSENT: 'basic_consent',
    CUSTOM: 'custom_consent_template'
});

const TEMPLATE_TYPE_TO_TEMPLATE_SUBTYPE = Object.freeze({
    SENSITIVE_DATA_CONSENT: DOCUMENT_TEMPLATE_SUBTYPES.MANDATORY_CONSENT,
    GENERAL_ATTENTION_CONSENT: DOCUMENT_TEMPLATE_SUBTYPES.CLINICAL_CONSENT,
    TREATMENT_PLAN_CONSENT: DOCUMENT_TEMPLATE_SUBTYPES.TREATMENT_CONSENT
});

const SUBTYPE_TO_LICENSE_CATEGORY = Object.freeze({
    basic: 'basic_document',
    mandatory_consent: 'mandatory_consent',
    clinical_consent: 'clinical_consent',
    treatment_consent: 'treatment_consent',
    custom_basic: 'basic_document',
    custom_clinical: 'clinical_consent',
    custom_advanced: 'advanced_document',
    custom_premium: 'premium_document_template',
    premium_multi_signature: 'premium_document_template',
    premium_witnesses: 'premium_document_template',
    premium_automation: 'premium_document_template',
    unknown: 'unknown'
});

const UNKNOWN_DOCUMENT_LICENSING_RULE = Object.freeze({
    code: 'unknown',
    label: 'Tipo documental desconocido',
    description: 'template_type no reconocido por la taxonomia SaaS actual.',
    minimumPlan: 'basic',
    blockMode: DOCUMENT_BLOCK_MODES.REQUIRES_REDESIGN,
    clinicalLegalSafe: false,
    canBlockCreate: false,
    canBlockRead: false,
    canBlockSign: false,
    canBlockDownload: false,
    canBlockAudit: false,
    recommendedFeature: null,
    notes: 'No asumir premium para evitar bloqueo clinico/legal accidental.'
});

const UNKNOWN_CONSENT_LICENSING_RULE = Object.freeze({
    code: 'unknown_consent',
    description: 'Consentimiento no reconocido por la taxonomia SaaS actual.',
    minimumPlan: 'basic',
    mustBeAvailableInBasic: true,
    canBlockCreate: false,
    canBlockRead: false,
    canBlockSign: false,
    clinicalLegalRisk: 'unknown',
    recommendedFeature: null,
    notes: 'No asumir premium para evitar bloqueo legal accidental.'
});

module.exports = {
    DOCUMENT_BLOCK_MODES,
    DOCUMENT_TEMPLATE_SUBTYPES,
    DOCUMENT_LICENSING_CATEGORIES,
    CONSENT_LICENSING_CATEGORIES,
    TEMPLATE_TYPE_TO_DOCUMENT_CATEGORY,
    CONSENT_TYPE_TO_CONSENT_CATEGORY,
    TEMPLATE_TYPE_TO_TEMPLATE_SUBTYPE,
    SUBTYPE_TO_LICENSE_CATEGORY,
    UNKNOWN_DOCUMENT_LICENSING_RULE,
    UNKNOWN_CONSENT_LICENSING_RULE
};

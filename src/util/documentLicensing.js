const {
    DOCUMENT_LICENSING_CATEGORIES,
    CONSENT_LICENSING_CATEGORIES,
    TEMPLATE_TYPE_TO_DOCUMENT_CATEGORY,
    CONSENT_TYPE_TO_CONSENT_CATEGORY,
    TEMPLATE_TYPE_TO_TEMPLATE_SUBTYPE,
    SUBTYPE_TO_LICENSE_CATEGORY,
    UNKNOWN_DOCUMENT_LICENSING_RULE,
    UNKNOWN_CONSENT_LICENSING_RULE
} = require('../config/documentLicensing');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeCode(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeMetadataCode(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeBoolean(value) {
    if (value === true || value === 1 || value === '1') {
        return true;
    }

    if (value === false || value === 0 || value === '0') {
        return false;
    }

    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === 'si') {
        return true;
    }

    if (normalized === 'false' || normalized === 'no') {
        return false;
    }

    return null;
}

function getTemplateType(templateOrType) {
    if (templateOrType && typeof templateOrType === 'object') {
        return normalizeCode(templateOrType.template_type || templateOrType.templateType || templateOrType.document_type);
    }

    return normalizeCode(templateOrType);
}

function readMetadataValue(template, snakeCaseKey, camelCaseKey) {
    if (Object.prototype.hasOwnProperty.call(template, snakeCaseKey)) {
        return template[snakeCaseKey];
    }

    if (Object.prototype.hasOwnProperty.call(template, camelCaseKey)) {
        return template[camelCaseKey];
    }

    return undefined;
}

function getDocumentLicensingCategory(templateType) {
    const type = normalizeCode(templateType);
    return TEMPLATE_TYPE_TO_DOCUMENT_CATEGORY[type] || UNKNOWN_DOCUMENT_LICENSING_RULE.code;
}

function getDocumentLicensingRule(templateType) {
    const type = normalizeCode(templateType);
    const categoryCode = TEMPLATE_TYPE_TO_DOCUMENT_CATEGORY[type];
    const rule = categoryCode ? DOCUMENT_LICENSING_CATEGORIES[categoryCode] : UNKNOWN_DOCUMENT_LICENSING_RULE;

    return Object.assign(clone(rule), {
        templateType: type || null,
        category: rule.code,
        knownTemplateType: Boolean(categoryCode)
    });
}

function isDocumentReadAlwaysAllowed(templateType) {
    const rule = getDocumentLicensingRule(templateType);
    return rule.canBlockRead === false;
}

function isDocumentSignatureAlwaysAllowed(templateType) {
    const rule = getDocumentLicensingRule(templateType);
    return rule.canBlockSign === false;
}

function canDocumentCreationBeBlocked(templateType) {
    const rule = getDocumentLicensingRule(templateType);
    return rule.canBlockCreate === true;
}

function getRuleForLicenseCategory(categoryCode) {
    const code = normalizeMetadataCode(categoryCode);

    if (DOCUMENT_LICENSING_CATEGORIES[code]) {
        return clone(DOCUMENT_LICENSING_CATEGORIES[code]);
    }

    if (CONSENT_LICENSING_CATEGORIES[code]) {
        const consent = CONSENT_LICENSING_CATEGORIES[code];
        return {
            code: consent.code,
            label: consent.code,
            description: consent.description,
            minimumPlan: consent.minimumPlan,
            blockMode: consent.canBlockCreate ? 'hard_block_create_only' : 'never',
            clinicalLegalSafe: consent.mustBeAvailableInBasic === true,
            canBlockCreate: consent.canBlockCreate === true,
            canBlockRead: consent.canBlockRead === true,
            canBlockSign: consent.canBlockSign === true,
            canBlockDownload: false,
            canBlockAudit: false,
            recommendedFeature: consent.recommendedFeature,
            notes: consent.notes
        };
    }

    return clone(UNKNOWN_DOCUMENT_LICENSING_RULE);
}

function resolveDocumentTemplateSubtype(templateOrType) {
    const template = templateOrType && typeof templateOrType === 'object' ? templateOrType : { template_type: templateOrType };
    const type = getTemplateType(template);

    if (TEMPLATE_TYPE_TO_TEMPLATE_SUBTYPE[type] && type !== 'CUSTOM') {
        return TEMPLATE_TYPE_TO_TEMPLATE_SUBTYPE[type];
    }

    const explicitSubtype = normalizeMetadataCode(template.template_subtype || template.templateSubtype);

    if (explicitSubtype && SUBTYPE_TO_LICENSE_CATEGORY[explicitSubtype]) {
        return explicitSubtype;
    }

    if (TEMPLATE_TYPE_TO_TEMPLATE_SUBTYPE[type]) {
        return TEMPLATE_TYPE_TO_TEMPLATE_SUBTYPE[type];
    }

    return 'unknown';
}

function resolveDocumentLicenseCategory(templateOrType) {
    const template = templateOrType && typeof templateOrType === 'object' ? templateOrType : { template_type: templateOrType };
    const type = getTemplateType(template);
    const knownTypeCategory = TEMPLATE_TYPE_TO_DOCUMENT_CATEGORY[type];

    if (knownTypeCategory && type !== 'CUSTOM') {
        return knownTypeCategory;
    }

    const subtype = resolveDocumentTemplateSubtype(template);
    const subtypeCategory = SUBTYPE_TO_LICENSE_CATEGORY[subtype];
    if (subtypeCategory && subtypeCategory !== 'unknown') {
        return subtypeCategory;
    }

    const explicitCategory = normalizeMetadataCode(template.license_category || template.licenseCategory);
    if (explicitCategory && (DOCUMENT_LICENSING_CATEGORIES[explicitCategory] || CONSENT_LICENSING_CATEGORIES[explicitCategory])) {
        return explicitCategory;
    }

    if (normalizeBoolean(readMetadataValue(template, 'is_premium', 'isPremium')) === true) {
        return 'premium_document_template';
    }

    if (type === 'CUSTOM') {
        return 'custom_document_template';
    }

    return UNKNOWN_DOCUMENT_LICENSING_RULE.code;
}

function isTemplatePremium(templateOrType) {
    const template = templateOrType && typeof templateOrType === 'object' ? templateOrType : { template_type: templateOrType };
    const explicit = normalizeBoolean(readMetadataValue(template, 'is_premium', 'isPremium'));

    if (explicit !== null) {
        return explicit;
    }

    const category = resolveDocumentLicenseCategory(template);
    return category === 'premium_document_template' || category === 'premium_consent_template';
}

function resolveDocumentLicenseMetadata(templateOrType) {
    const template = templateOrType && typeof templateOrType === 'object' ? templateOrType : { template_type: templateOrType };
    const type = getTemplateType(template);
    const subtype = resolveDocumentTemplateSubtype(template);
    const category = resolveDocumentLicenseCategory(template);
    const rule = getRuleForLicenseCategory(category);
    const knownTypeCategory = TEMPLATE_TYPE_TO_DOCUMENT_CATEGORY[type];
    const protectsKnownType = Boolean(knownTypeCategory && type !== 'CUSTOM');
    const explicitMinimumPlan = normalizeMetadataCode(template.minimum_plan || template.minimumPlan);
    const explicitBlockMode = normalizeMetadataCode(template.block_mode || template.blockMode);
    const explicitClinicalLegalSafe = normalizeBoolean(readMetadataValue(template, 'clinical_legal_safe', 'clinicalLegalSafe'));
    const explicitIsPremium = normalizeBoolean(readMetadataValue(template, 'is_premium', 'isPremium'));
    const premium = protectsKnownType ? false : isTemplatePremium(template);
    const metadataComplete = subtype !== 'unknown'
        || Boolean(template.license_category || template.licenseCategory)
        || explicitIsPremium === true;

    return Object.assign(rule, {
        templateType: type || null,
        templateSubtype: subtype,
        licenseCategory: category,
        minimumPlan: protectsKnownType || !explicitMinimumPlan ? rule.minimumPlan : explicitMinimumPlan,
        blockMode: protectsKnownType || !explicitBlockMode ? rule.blockMode : explicitBlockMode,
        clinicalLegalSafe: protectsKnownType || explicitClinicalLegalSafe === null ? rule.clinicalLegalSafe : explicitClinicalLegalSafe,
        isPremium: premium,
        metadataComplete,
        knownTemplateType: Boolean(knownTypeCategory),
        requiresMetadataBeforeEnforcement: type === 'CUSTOM' && !metadataComplete,
        canBlockCreate: protectsKnownType ? false : rule.canBlockCreate === true,
        canBlockRead: false,
        canBlockSign: false,
        canBlockDownload: false,
        canBlockAudit: false
    });
}

function isTemplateClinicalLegalSafe(templateOrType) {
    return resolveDocumentLicenseMetadata(templateOrType).clinicalLegalSafe === true;
}

function isTemplateEligibleForFutureEnforcement(templateOrType) {
    const metadata = resolveDocumentLicenseMetadata(templateOrType);
    return metadata.canBlockCreate === true
        && metadata.clinicalLegalSafe !== true
        && metadata.blockMode !== 'never'
        && metadata.blockMode !== 'requires_redesign'
        && metadata.requiresMetadataBeforeEnforcement !== true;
}

function getDocumentTemplateEnforcementCandidate(templateOrType) {
    const metadata = resolveDocumentLicenseMetadata(templateOrType);
    const eligible = isTemplateEligibleForFutureEnforcement(templateOrType);
    let reason = 'not_blockable';

    if (eligible) {
        reason = 'future_enforcement_candidate';
    } else if (metadata.requiresMetadataBeforeEnforcement) {
        reason = 'metadata_required';
    } else if (metadata.clinicalLegalSafe) {
        reason = 'clinical_legal_safe';
    } else if (metadata.blockMode === 'requires_redesign') {
        reason = 'requires_redesign';
    }

    return {
        eligible,
        reason,
        templateType: metadata.templateType,
        templateSubtype: metadata.templateSubtype,
        licenseCategory: metadata.licenseCategory,
        minimumPlan: metadata.minimumPlan,
        blockMode: metadata.blockMode,
        isPremium: metadata.isPremium,
        clinicalLegalSafe: metadata.clinicalLegalSafe
    };
}

function getConsentLicensingRule(consentType) {
    const type = normalizeCode(consentType);
    const categoryCode = CONSENT_TYPE_TO_CONSENT_CATEGORY[type];
    const rule = categoryCode ? CONSENT_LICENSING_CATEGORIES[categoryCode] : UNKNOWN_CONSENT_LICENSING_RULE;

    return Object.assign(clone(rule), {
        consentType: type || null,
        category: rule.code,
        knownConsentType: Boolean(categoryCode)
    });
}

function isConsentAlwaysBasic(consentType) {
    const rule = getConsentLicensingRule(consentType);
    return rule.minimumPlan === 'basic' && rule.mustBeAvailableInBasic === true;
}

module.exports = {
    getDocumentLicensingCategory,
    getDocumentLicensingRule,
    isDocumentReadAlwaysAllowed,
    isDocumentSignatureAlwaysAllowed,
    canDocumentCreationBeBlocked,
    resolveDocumentLicenseMetadata,
    resolveDocumentTemplateSubtype,
    resolveDocumentLicenseCategory,
    isTemplatePremium,
    isTemplateClinicalLegalSafe,
    isTemplateEligibleForFutureEnforcement,
    getDocumentTemplateEnforcementCandidate,
    getConsentLicensingRule,
    isConsentAlwaysBasic
};

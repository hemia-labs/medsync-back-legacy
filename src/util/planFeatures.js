const AdminAuditDao = require('../Dao/mysql/adminAudit.dao');
const { getEffectiveDashboardCapabilities } = require('../config/dashboardCapabilities');
const { getBusinessEffectiveLicense } = require('./licenseLimits');

const PLAN_FEATURE_NOT_ALLOWED = 'PLAN_FEATURE_NOT_ALLOWED';
const PLAN_FEATURE_BLOCKED = 'PLAN_FEATURE_BLOCKED';
const FEATURE_FORBIDDEN_STATUS = 403;

const FEATURE_DEFINITIONS = Object.freeze({
    basic_dashboard: {
        capability: null,
        requiredPlan: 'basic',
        area: 'dashboard'
    },
    trends: {
        capability: 'trends',
        requiredPlan: 'pro',
        area: 'dashboard'
    },
    operational_analysis: {
        capability: 'operationalAnalysis',
        requiredPlan: 'pro',
        area: 'dashboard'
    },
    professional_activity_metrics: {
        capability: 'professionalBreakdown',
        requiredPlan: 'enterprise',
        area: 'dashboard'
    },
    team_usage_metrics: {
        capability: 'teamBreakdown',
        requiredPlan: 'enterprise',
        area: 'dashboard'
    },
    advanced_basic_reports: {
        capability: 'advancedReports',
        requiredPlan: 'enterprise',
        area: 'dashboard'
    },
    custom_templates: {
        allowedPlans: ['pro', 'enterprise'],
        requiredPlan: 'pro',
        area: 'clinical_templates'
    },
    advanced_documents: {
        allowedPlans: ['pro', 'enterprise'],
        requiredPlan: 'pro',
        area: 'documents'
    },
    premium_document_templates: {
        allowedPlans: ['enterprise'],
        requiredPlan: 'enterprise',
        area: 'documents'
    }
});

const SAFE_AUDIT_METADATA_KEYS = Object.freeze([
    'template_type',
    'license_category',
    'template_subtype',
    'block_mode'
]);

function normalizeFeatureCode(featureCode) {
    return String(featureCode || '').trim();
}

function pickSafeAuditMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') {
        return {};
    }

    return SAFE_AUDIT_METADATA_KEYS.reduce((acc, key) => {
        if (metadata[key] !== undefined && metadata[key] !== null) {
            acc[key] = metadata[key];
        }
        return acc;
    }, {});
}

function featureNotAllowed({ planCode, feature, requiredPlan }) {
    return {
        status: FEATURE_FORBIDDEN_STATUS,
        data: {
            code: PLAN_FEATURE_NOT_ALLOWED,
            feature,
            details: {
                plan: planCode || null,
                feature,
                requiredPlan: requiredPlan || null
            }
        },
        message: 'Tu plan actual no incluye esta funcionalidad.'
    };
}

function isAllowedByDefinition(definition, planFeatures) {
    const planCode = planFeatures.plan && planFeatures.plan.code ? planFeatures.plan.code : null;

    if (definition.allowedPlans) {
        return definition.allowedPlans.includes(planCode);
    }

    if (!definition.capability) {
        return true;
    }

    return Boolean(planFeatures.capabilities[definition.capability]);
}

async function auditFeatureBlocked({ idBusiness, actorLoginId, planCode, feature, requiredPlan, endpoint, method, action, templateId, metadata }) {
    await AdminAuditDao.record(PLAN_FEATURE_BLOCKED, {
        actor_login_id: actorLoginId || null,
        actor_role: 'tenant_user',
        target_type: 'business',
        target_business_id: idBusiness || null,
        target_id: idBusiness || null,
        metadata: Object.assign({
            business_id: idBusiness || null,
            plan: planCode || null,
            feature,
            required_plan: requiredPlan || null,
            endpoint: endpoint || null,
            method: method || null,
            action: action || null,
            template_id: templateId || null,
            reason: 'plan_feature_not_allowed'
        }, pickSafeAuditMetadata(metadata))
    });
}

async function getBusinessPlanFeatures(idBusiness) {
    const license = await getBusinessEffectiveLicense(idBusiness);

    if (!license) {
        return null;
    }

    const planCode = license.plan && license.plan.code ? license.plan.code : null;
    const dashboard = getEffectiveDashboardCapabilities(planCode);

    return {
        license,
        business: license.business,
        plan: license.plan,
        dashboard,
        features: license.plan && license.plan.features ? license.plan.features : [],
        capabilities: dashboard && dashboard.capabilities ? dashboard.capabilities : {}
    };
}

async function isFeatureEnabledForBusiness(idBusiness, featureCode) {
    const feature = normalizeFeatureCode(featureCode);
    const definition = FEATURE_DEFINITIONS[feature];
    const planFeatures = await getBusinessPlanFeatures(idBusiness);

    if (!planFeatures || !definition) {
        return false;
    }

    return isAllowedByDefinition(definition, planFeatures);
}

async function assertPlanFeature(idBusiness, featureCode, context = {}) {
    const feature = normalizeFeatureCode(featureCode);
    const definition = FEATURE_DEFINITIONS[feature];
    const planFeatures = await getBusinessPlanFeatures(idBusiness);

    if (!planFeatures) {
        return {
            error: {
                status: 400,
                data: null,
                message: 'Negocio invalido para validar funcionalidad del plan.'
            }
        };
    }

    if (!definition) {
        return {
            error: {
                status: 400,
                data: null,
                message: 'Funcionalidad de plan no reconocida.'
            }
        };
    }

    const allowed = isAllowedByDefinition(definition, planFeatures);

    if (!allowed) {
        const planCode = planFeatures.plan && planFeatures.plan.code ? planFeatures.plan.code : null;
        await auditFeatureBlocked({
            idBusiness,
            actorLoginId: context.actorLoginId || null,
            planCode,
            feature,
            requiredPlan: definition.requiredPlan,
            endpoint: context.endpoint || null,
            method: context.method || null,
            action: context.action || null,
            templateId: context.templateId || null,
            metadata: context.metadata || null
        });

        return {
            error: featureNotAllowed({
                planCode,
                feature,
                requiredPlan: definition.requiredPlan
            })
        };
    }

    return {
        allowed: true,
        license: planFeatures.license,
        dashboard: planFeatures.dashboard,
        features: planFeatures.features,
        capabilities: planFeatures.capabilities
    };
}

module.exports = {
    PLAN_FEATURE_NOT_ALLOWED,
    PLAN_FEATURE_BLOCKED,
    FEATURE_DEFINITIONS,
    assertPlanFeature,
    getBusinessPlanFeatures,
    isFeatureEnabledForBusiness
};

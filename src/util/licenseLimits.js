const responseData = require('./responsedata');
const AdminAuditDao = require('../Dao/mysql/adminAudit.dao');
const LicenseUsageDao = require('../Dao/mysql/licenseUsage.dao');
const { getSaasPlan, getUnknownSaasPlan } = require('../config/saasPlans');

const LICENSE_LIMIT_EXCEEDED = 'LICENSE_LIMIT_EXCEEDED';
const LICENSE_LIMIT_BLOCKED = 'LICENSE_LIMIT_BLOCKED';
const LICENSE_LIMIT_CONFLICT_STATUS = 409;
const LICENSE_LIMIT_LEGACY_STATUS = 403;

function normalizeRoleCode(roleCode) {
    return String(roleCode || '').trim().toLowerCase();
}

function classifyUserForLicense(userOrRole = {}) {
    const roleCode = normalizeRoleCode(userOrRole.code || userOrRole.role || userOrRole.rol || userOrRole.roleCode);

    if (LicenseUsageDao.IGNORED_ROLE_CODES.includes(roleCode)) {
        return 'ignored';
    }

    if (LicenseUsageDao.PROFESSIONAL_ROLE_CODES.includes(roleCode)) {
        return 'professional';
    }

    if (LicenseUsageDao.AUXILIARY_ROLE_CODES.includes(roleCode)) {
        return 'auxiliary';
    }

    return 'unknown';
}

function normalizeActiveFlag(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return Boolean(fallback);
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value).trim().toLowerCase();
    return ['1', 'true', 'active', 'activo'].includes(normalized);
}

function classifyLicenseResource(userState = {}, options = {}) {
    const active = normalizeActiveFlag(userState.active, false);
    const category = classifyUserForLicense(userState);

    if (category === 'ignored') {
        return 'super_admin';
    }

    if (!active) {
        return 'none';
    }

    if (category === 'professional' || normalizeActiveFlag(userState.hasActiveProfessionalProfile, false)) {
        return 'professional';
    }

    if (category === 'auxiliary') {
        return 'staff';
    }

    return options.unknownAsStaff ? 'staff' : 'unknown';
}

function toInternalResource(resource) {
    if (resource === 'professional') {
        return 'professionals';
    }

    if (resource === 'staff') {
        return 'auxiliaryUsers';
    }

    return resource;
}

function toPublicResource(resource) {
    if (resource === 'professionals') {
        return 'professional';
    }

    if (resource === 'auxiliaryUsers' || resource === 'staffUsers') {
        return 'staff';
    }

    return resource;
}

function getRecommendedPlan(planCode, resource) {
    const plan = normalizeRoleCode(planCode);

    if (resource === 'auxiliaryUsers') {
        if (plan === 'basic') {
            return 'pro';
        }

        if (plan === 'pro') {
            return 'enterprise';
        }
    }

    if (resource === 'professionals') {
        if (plan === 'basic' || plan === 'pro') {
            return 'enterprise';
        }
    }

    return null;
}

function buildPlanLimits(plan) {
    return {
        professionals: plan.maxProfessionals,
        auxiliaryUsers: plan.maxAuxiliaryUsers,
        staffUsers: plan.maxStaffUsers === undefined ? plan.maxAuxiliaryUsers : plan.maxStaffUsers,
        branches: plan.maxBranches
    };
}

function activeOverrideValue(overrides, key) {
    if (!overrides || overrides.expired) {
        return 0;
    }

    return Number(overrides[key] || 0);
}

function buildEffectiveLimits(plan, overrides) {
    const addOverride = (base, key) => {
        if (base === null || base === undefined) {
            return null;
        }
        return Number(base || 0) + activeOverrideValue(overrides, key);
    };

    return {
        professionals: addOverride(plan.maxProfessionals, 'extra_professionals'),
        auxiliaryUsers: addOverride(plan.maxAuxiliaryUsers, 'extra_auxiliary_users'),
        staffUsers: addOverride(plan.maxStaffUsers === undefined ? plan.maxAuxiliaryUsers : plan.maxStaffUsers, 'extra_auxiliary_users'),
        // Branches se conservan como placeholder tecnico interno; los overrides de sucursal no aplican en L2-A.
        branches: plan.maxBranches
    };
}

function buildLimitUsage(used, limit) {
    const normalizedUsed = Number(used || 0);

    if (limit === null || limit === undefined) {
        return {
            used: normalizedUsed,
            limit: null,
            remaining: null,
            exceeded: false
        };
    }

    const normalizedLimit = Number(limit);
    return {
        used: normalizedUsed,
        limit: normalizedLimit,
        remaining: Math.max(normalizedLimit - normalizedUsed, 0),
        exceeded: normalizedUsed > normalizedLimit
    };
}

async function getBusinessEffectiveLicense(idBusiness) {
    const business = await LicenseUsageDao.getBusinessPlan(idBusiness);
    if (!business) {
        return null;
    }

    const plan = getSaasPlan(business.plan) || getUnknownSaasPlan(business.plan);
    const usage = await LicenseUsageDao.getBusinessLicenseUsage(idBusiness);
    const overrides = await LicenseUsageDao.getBusinessLicenseOverride(idBusiness);
    const planLimits = buildPlanLimits(plan);
    const effectiveLimits = buildEffectiveLimits(plan, overrides);

    return {
        business,
        plan,
        usage,
        overrides,
        planLimits,
        effectiveLimits,
        limits: {
            professionals: buildLimitUsage(usage.professionals, effectiveLimits.professionals),
            auxiliaryUsers: buildLimitUsage(usage.auxiliaryUsers, effectiveLimits.auxiliaryUsers),
            staffUsers: buildLimitUsage(usage.staffUsers === undefined ? usage.auxiliaryUsers : usage.staffUsers, effectiveLimits.staffUsers),
            branches: buildLimitUsage(usage.branches, effectiveLimits.branches)
        }
    };
}

function buildUpgradeMessage(plan, resource, recommendedPlan) {
    const limit = resource === 'professionals' ? plan.maxProfessionals : plan.maxAuxiliaryUsers;
    const resourceLabel = resource === 'professionals'
        ? (Number(limit) === 1 ? 'profesional' : 'profesionales')
        : (Number(limit) === 1 ? 'usuario interno' : 'usuarios internos');

    if (!recommendedPlan) {
        return `Tu plan ${plan.name} llego al limite incluido. Contacta soporte para ampliar tu licencia.`;
    }

    const recommended = getSaasPlan(recommendedPlan);
    return `Tu plan ${plan.name} permite ${limit} ${resourceLabel}. Actualiza a ${recommended ? recommended.name : recommendedPlan} para agregar mas.`;
}

function forbiddenLimit(plan, resource, used, limit, recommendedPlan, attemptedRole) {
    const publicResource = toPublicResource(resource);

    return {
        status: LICENSE_LIMIT_CONFLICT_STATUS,
        data: {
            code: LICENSE_LIMIT_EXCEEDED,
            resource: publicResource,
            details: {
                plan: plan.code,
                planName: plan.name,
                resource: publicResource,
                legacyResource: resource,
                used,
                current: used,
                limit,
                remaining: Math.max(Number(limit || 0) - Number(used || 0), 0),
                attempted_role: attemptedRole || null,
                recommendedPlan
            }
        },
        message: buildUpgradeMessage(plan, resource, recommendedPlan)
    };
}

function unknownRole(roleCode) {
    return responseData.bad_request(`El rol ${roleCode || 'sin codigo'} no esta clasificado para licencia.`);
}

async function auditBlocked({
    idBusiness,
    actorLoginId,
    targetLoginId,
    roleCode,
    plan,
    resource,
    usage,
    limit,
    recommendedPlan,
    action,
    previousResource,
    nextResource,
    reason
}) {
    await AdminAuditDao.record(LICENSE_LIMIT_BLOCKED, {
        actor_login_id: actorLoginId || null,
        actor_role: 'tenant_user',
        target_type: targetLoginId ? 'login' : 'business',
        target_business_id: idBusiness,
        target_login_id: targetLoginId || null,
        target_id: targetLoginId || idBusiness,
        metadata: {
            business_id: idBusiness,
            target_login_id: targetLoginId || null,
            action: action || null,
            plan: plan.code,
            resource: toPublicResource(resource),
            legacy_resource: resource,
            used: usage,
            current: usage,
            limit,
            attempted_role: roleCode || null,
            recommended_plan: recommendedPlan || null,
            previous_resource: previousResource || null,
            next_resource: nextResource || null,
            reason: reason || null
        }
    });
}

async function validateResourceLimit({ idBusiness, resource, actorLoginId, roleCode }) {
    const license = await getBusinessEffectiveLicense(idBusiness);
    if (!license) {
        return responseData.bad_request('Negocio invalido para validar licencia.');
    }

    const { plan, effectiveLimits } = license;
    const limit = resource === 'professionals' ? effectiveLimits.professionals : effectiveLimits.auxiliaryUsers;

    if (limit === null || limit === undefined) {
        return { allowed: true };
    }

    const usage = license.usage;
    const used = Number(usage[resource] || 0);

    if (used < Number(limit)) {
        return { allowed: true };
    }

    const recommendedPlan = getRecommendedPlan(plan.code, resource);
    await auditBlocked({
        idBusiness,
        actorLoginId,
        roleCode,
        plan,
        resource,
        usage: used,
        limit: Number(limit),
        recommendedPlan,
        action: 'create'
    });

    return {
        allowed: false,
        response: forbiddenLimit(plan, resource, used, Number(limit), recommendedPlan, roleCode)
    };
}

async function validateLicenseTransition({
    idBusiness,
    targetLoginId = null,
    currentResource,
    nextResource,
    actorLoginId = null,
    roleCode = null,
    action = 'update_user'
}) {
    if (currentResource === 'super_admin' || nextResource === 'super_admin' || nextResource === 'none') {
        return { allowed: true };
    }

    if (nextResource === 'unknown') {
        return unknownRole(roleCode);
    }

    if (currentResource === nextResource) {
        return { allowed: true };
    }

    if (!idBusiness) {
        return responseData.bad_request('Negocio requerido para validar licencia.');
    }

    const internalResource = toInternalResource(nextResource);
    const license = await getBusinessEffectiveLicense(idBusiness);
    if (!license) {
        return responseData.bad_request('Negocio invalido para validar licencia.');
    }

    const limit = internalResource === 'professionals'
        ? license.effectiveLimits.professionals
        : license.effectiveLimits.auxiliaryUsers;

    if (limit === null || limit === undefined) {
        return { allowed: true };
    }

    const usage = license.usage;
    const used = Number(usage[internalResource] || 0);

    if (used < Number(limit)) {
        return { allowed: true };
    }

    const recommendedPlan = getRecommendedPlan(license.plan.code, internalResource);
    await auditBlocked({
        idBusiness,
        actorLoginId,
        targetLoginId,
        roleCode,
        plan: license.plan,
        resource: internalResource,
        usage: used,
        limit: Number(limit),
        recommendedPlan,
        action,
        previousResource: currentResource,
        nextResource,
        reason: 'license_transition_limit_exceeded'
    });

    return {
        allowed: false,
        response: forbiddenLimit(license.plan, internalResource, used, Number(limit), recommendedPlan, roleCode)
    };
}

async function validateLicenseForNewUser(idBusiness, roleOrPayload = {}, actorLoginId = null) {
    const role = roleOrPayload.code
        ? roleOrPayload
        : await LicenseUsageDao.getRoleById(roleOrPayload.id_rol || roleOrPayload.idRole);

    if (!role) {
        return responseData.bad_request('Rol invalido para validar licencia.');
    }

    const category = classifyUserForLicense(role);

    if (category === 'ignored') {
        return { allowed: true };
    }

    if (!idBusiness) {
        return responseData.bad_request('Negocio requerido para validar licencia.');
    }

    if (category === 'unknown') {
        return unknownRole(role.code);
    }

    const resource = category === 'professional' ? 'professionals' : 'auxiliaryUsers';
    return validateResourceLimit({
        idBusiness,
        resource,
        actorLoginId,
        roleCode: role.code
    });
}

async function validateLicenseForProfessionalProfile(idBusiness, idLogin, actorLoginId = null) {
    const currentState = await LicenseUsageDao.getLicenseUserState(idBusiness, idLogin);
    if (!currentState) {
        return responseData.bad_request('Usuario invalido para validar licencia.');
    }

    const currentResource = classifyLicenseResource(currentState, { unknownAsStaff: true });
    const nextResource = classifyLicenseResource({
        ...currentState,
        hasActiveProfessionalProfile: true
    });

    return validateLicenseTransition({
        idBusiness,
        targetLoginId: idLogin,
        currentResource,
        nextResource,
        actorLoginId,
        roleCode: currentState.roleCode || 'professional_profile',
        action: 'professional_profile_activate'
    });
}

module.exports = {
    LICENSE_LIMIT_EXCEEDED,
    LICENSE_LIMIT_BLOCKED,
    LICENSE_LIMIT_CONFLICT_STATUS,
    LICENSE_LIMIT_LEGACY_STATUS,
    classifyUserForLicense,
    classifyLicenseResource,
    getBusinessLicenseUsage: LicenseUsageDao.getBusinessLicenseUsage,
    getBusinessEffectiveLicense,
    canCreateProfessional: (idBusiness, actorLoginId = null) => validateResourceLimit({
        idBusiness,
        resource: 'professionals',
        actorLoginId,
        roleCode: 'professional'
    }),
    canCreateAuxiliaryUser: (idBusiness, actorLoginId = null) => validateResourceLimit({
        idBusiness,
        resource: 'auxiliaryUsers',
        actorLoginId,
        roleCode: 'auxiliary'
    }),
    validateLicenseForNewUser,
    validateLicenseForProfessionalProfile,
    validateLicenseTransition,
    getRecommendedPlan
};

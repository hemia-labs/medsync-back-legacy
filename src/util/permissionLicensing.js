const {
    PLAN_ORDER,
    PERMISSION_LICENSING_CATEGORIES,
    PERMISSION_RULE_OVERRIDES
} = require('../config/permissionLicensing');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizePermissionCode(permissionCode) {
    return String(permissionCode || '').trim().toLowerCase();
}

function normalizePlanCode(planCode) {
    return String(planCode || '').trim().toLowerCase();
}

function getInferredPermissionCategory(permissionCode) {
    if (permissionCode.indexOf('super_admin') === 0 || permissionCode.indexOf('platform.') === 0) {
        return 'super_admin_permission';
    }

    return 'unknown_permission';
}

function getPermissionLicensingRule(permissionCode) {
    const code = normalizePermissionCode(permissionCode);
    const override = PERMISSION_RULE_OVERRIDES[code] || null;
    const categoryCode = override ? override.category : getInferredPermissionCategory(code);
    const category = PERMISSION_LICENSING_CATEGORIES[categoryCode] || PERMISSION_LICENSING_CATEGORIES.unknown_permission;

    return Object.assign(clone(category), {
        permissionCode: code || null,
        module: override && override.module ? override.module : null,
        description: override && override.description ? override.description : 'Permiso clasificado por taxonomia tecnica.',
        knownPermissionCode: Boolean(override)
    });
}

function classifyPermissionForLicensing(permissionCode) {
    return getPermissionLicensingRule(permissionCode).category;
}

function planAllowsPermissionRule(planCode, rule) {
    const plan = normalizePlanCode(planCode) || 'basic';

    if (!rule || rule.category === 'unknown_permission') {
        return true;
    }

    if (rule.isSuperAdminOnly) {
        return false;
    }

    if (!rule.canBlockByPlan) {
        return true;
    }

    return (PLAN_ORDER[plan] || 0) >= (PLAN_ORDER[rule.minimumPlan] || 0);
}

function uniquePermissionCodes(permissionCodes) {
    const values = Array.isArray(permissionCodes) ? permissionCodes : [];
    const seen = {};

    return values
        .map(normalizePermissionCode)
        .filter((code) => {
            if (!code || seen[code]) {
                return false;
            }
            seen[code] = true;
            return true;
        });
}

function getPremiumPermissions(permissionCodes) {
    return uniquePermissionCodes(permissionCodes).filter((code) => getPermissionLicensingRule(code).isPremium === true);
}

function getForbiddenPermissionsForPlan(permissionCodes, planCode) {
    return uniquePermissionCodes(permissionCodes).filter((code) => {
        const rule = getPermissionLicensingRule(code);
        return planAllowsPermissionRule(planCode, rule) === false;
    });
}

function diffPermissions(currentPermissions, nextPermissions, planCode) {
    const current = uniquePermissionCodes(currentPermissions);
    const next = uniquePermissionCodes(nextPermissions);
    const currentSet = new Set(current);
    const nextSet = new Set(next);
    const permissionsToAdd = next.filter((code) => !currentSet.has(code));
    const permissionsToRemove = current.filter((code) => !nextSet.has(code));
    const permissionsUnchanged = next.filter((code) => currentSet.has(code));
    const premiumRequested = permissionsToAdd.filter((code) => getPermissionLicensingRule(code).isPremium === true);
    const forbidden = permissionsToAdd.filter((code) => {
        const rule = getPermissionLicensingRule(code);
        return planAllowsPermissionRule(planCode, rule) === false;
    });

    return {
        permissions_to_add: permissionsToAdd,
        permissions_to_remove: permissionsToRemove,
        permissions_unchanged: permissionsUnchanged,
        premium_permissions_requested: premiumRequested,
        forbidden_permissions: forbidden,
        plan_allowed_permissions: permissionsToAdd.filter((code) => forbidden.indexOf(code) === -1)
    };
}

module.exports = {
    getPermissionLicensingRule,
    classifyPermissionForLicensing,
    getPremiumPermissions,
    getForbiddenPermissionsForPlan,
    diffPermissions
};

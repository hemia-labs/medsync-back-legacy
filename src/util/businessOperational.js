const SUPER_ADMIN_ROLE = 'super_admin';

const STATUS = {
    TRIAL: 'trial',
    ACTIVE: 'active',
    PAST_DUE: 'past_due',
    SUSPENDED: 'suspended',
    CANCELLED: 'cancelled'
};

const TENANT_NOT_OPERATIONAL = 'TENANT_NOT_OPERATIONAL';

const COMMERCIAL_MESSAGES = {
    inactive: 'Tu consultorio esta temporalmente restringido. Contacta soporte para revisar el estado de tu cuenta.',
    trial_expired: 'Tu consultorio esta temporalmente restringido. Puedes consultar el estado de tu cuenta y contactar soporte. Tus datos se mantienen resguardados.',
    past_due: 'Tu cuenta requiere revision comercial. Contacta soporte para reactivar la operacion completa.',
    suspended: 'Este consultorio esta suspendido temporalmente. Contacta soporte para revisar el motivo y los siguientes pasos.',
    cancelled: 'Este consultorio esta cancelado. Tus datos no se han eliminado. Contacta soporte si necesitas asistencia.',
    invalid: 'Tu consultorio esta temporalmente restringido. Contacta soporte para revisar el estado de tu cuenta.'
};

const deny = (reasonCode, message, status = null) => ({
    allowed: false,
    code: TENANT_NOT_OPERATIONAL,
    reasonCode,
    status,
    message
});

const allow = () => ({
    allowed: true,
    code: null,
    reasonCode: null,
    status: null,
    message: null
});

const toBooleanActive = (value) => value === true || value === 1 || value === '1';

const parseDate = (value) => {
    if (!value) {
        return null;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

function isBusinessOperational(business, now = new Date()) {
    if (!business) {
        return deny('TENANT_NOT_FOUND', 'No se encontro el negocio asociado a la sesion.', null);
    }

    if (!toBooleanActive(business.active)) {
        return deny('TENANT_INACTIVE', COMMERCIAL_MESSAGES.inactive, 'inactive');
    }

    const subscriptionStatus = String(business.subscription_status || '').trim().toLowerCase();

    if (subscriptionStatus === STATUS.TRIAL) {
        const trialEndsAt = parseDate(business.trial_ends_at);

        if (!trialEndsAt || trialEndsAt < now) {
            return deny('TRIAL_EXPIRED', COMMERCIAL_MESSAGES.trial_expired, STATUS.TRIAL);
        }

        return allow();
    }

    if (subscriptionStatus === STATUS.ACTIVE) {
        return allow();
    }

    if (subscriptionStatus === STATUS.PAST_DUE) {
        return deny('SUBSCRIPTION_PAST_DUE', COMMERCIAL_MESSAGES.past_due, STATUS.PAST_DUE);
    }

    if (subscriptionStatus === STATUS.SUSPENDED) {
        return deny('TENANT_SUSPENDED', COMMERCIAL_MESSAGES.suspended, STATUS.SUSPENDED);
    }

    if (subscriptionStatus === STATUS.CANCELLED) {
        return deny('TENANT_CANCELLED', COMMERCIAL_MESSAGES.cancelled, STATUS.CANCELLED);
    }

    return deny('TENANT_STATUS_INVALID', COMMERCIAL_MESSAGES.invalid, subscriptionStatus || null);
}

function isSuperAdminRole(role) {
    return role === SUPER_ADMIN_ROLE;
}

function buildTenantOperationalData(result) {
    const safeResult = result || {};
    return {
        allowed: safeResult.allowed === true,
        code: safeResult.code || null,
        reasonCode: safeResult.reasonCode || null,
        tenantStatus: safeResult.status || null,
        status: safeResult.status || null
    };
}

function buildTenantOperationalResponse(result) {
    const data = buildTenantOperationalData(result);
    return {
        code: data.code || 'TENANT_NOT_OPERATIONAL',
        reasonCode: data.reasonCode,
        tenantStatus: data.tenantStatus,
        data,
        message: result && result.message ? result.message : COMMERCIAL_MESSAGES.invalid
    };
}

module.exports = {
    STATUS,
    SUPER_ADMIN_ROLE,
    TENANT_NOT_OPERATIONAL,
    buildTenantOperationalData,
    buildTenantOperationalResponse,
    isBusinessOperational,
    isSuperAdminRole
};

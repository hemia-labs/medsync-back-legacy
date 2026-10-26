const { BusinessProvisioning } = require('../../services/registration/businessProvisioning');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const AdminAuditDao = require('./adminAudit.dao');
const { encript } = require('../../util/bcrypt');
const { v4: uuidv4 } = require('uuid');
const { isBusinessOperational } = require('../../util/businessOperational');
const { getTrialLifecycleStatus, runTrialLifecycleJob } = require('../../jobs/saasTrialLifecycle.job');
const {
    SAAS_PLAN_CODES,
    getSaasPlan,
    getSaasPlans,
    isValidSaasPlan,
    getPlanLabel,
    getPlanLimitsSummary,
    getUnknownSaasPlan
} = require('../../config/saasPlans');
const { getBusinessEffectiveLicense } = require('../../util/licenseLimits');
const LicenseUsageDao = require('./licenseUsage.dao');
const { getDashboardMetrics } = require('./superAdminDashboard.dao');
const SecurityConfig = require('../../config/security');

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const CREATED_STATUS = 201;
const CONFLICT_STATUS = 409;
const BUSINESS_STATUSES = ['active', 'inactive', 'suspended', 'trial'];
const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'];
const TRIAL_STATES = ['active', 'expired', 'expiring_soon'];
const ADMIN_ROLES_ALLOWED = ['admin', 'business_admin'];
const CREATE_SUBSCRIPTION_STATUSES = ['trial', 'active'];
const DEFAULT_TRIAL_DAYS = 60;
const SESSION_CLOSE_CONFIRMATION = 'CERRAR';
const MIN_TRIAL_DAYS = 1;
const MAX_TRIAL_DAYS = 365;
const MAX_MANUAL_TRIAL_EXTENSION_DAYS = 30;
const COMMERCIAL_PLANS = SAAS_PLAN_CODES;
const ADMIN_AUDIT_ACTIONS = [
    'SUPER_ADMIN_BUSINESS_CREATE',
    'SUPER_ADMIN_BUSINESS_UPDATE',
    'SUPER_ADMIN_BUSINESS_STATUS_CHANGE',
    'SUPER_ADMIN_BUSINESS_SUSPEND',
    'SUPER_ADMIN_BUSINESS_REACTIVATE',
    'SUPER_ADMIN_BUSINESS_CANCEL',
    'SUPER_ADMIN_BUSINESS_TRIAL_EXTEND',
    'SUPER_ADMIN_BUSINESS_PLAN_CHANGE',
    'SUPER_ADMIN_TRIAL_EXPIRED_TO_PAST_DUE',
    'SUPER_ADMIN_LICENSE_OVERRIDES_UPDATE',
    'LICENSE_LIMIT_BLOCKED',
    'PLAN_FEATURE_BLOCKED',
    'ROLE_PERMISSIONS_UPDATE',
    'ROLE_PERMISSIONS_BLOCKED',
    'SUPER_ADMIN_SESSION_CLOSE',
    'SUPER_ADMIN_USER_SESSIONS_CLOSE'
];
const BUSINESS_UPDATE_ALLOWED_FIELDS = ['name', 'legalName', 'legal_name', 'slug', 'email', 'phone', 'address'];
const BUSINESS_UPDATE_BLOCKED_FIELDS = [
    'active',
    'status',
    'subscription_status',
    'trial_starts_at',
    'trial_ends_at',
    'current_period_starts_at',
    'current_period_ends_at',
    'suspended_at',
    'cancelled_at',
    'status_reason',
    'plan',
    'logo_url',
    'logoUrl',
    'created_at',
    'created_by',
    'updated_at',
    'updated_by'
];
const LICENSE_OVERRIDE_ALLOWED_FIELDS = [
    'extra_professionals',
    'extra_auxiliary_users',
    'extraProfessionals',
    'extraAuxiliaryUsers',
    'reason',
    'valid_until',
    'validUntil'
];
const LICENSE_OVERRIDE_LIMITS = {
    extra_professionals: 50,
    extra_auxiliary_users: 100
};
const SENSITIVE_METADATA_KEYS = [
    'password',
    'hash',
    'token',
    'access_token',
    'refresh',
    'refresh_token',
    'authorization',
    'secret',
    'jwt',
    'credential',
    'credentials',
    'patient',
    'px',
    'expedient',
    'clinical',
    'diagnostic',
    'medication',
    'document',
    'prescription',
    'treatment',
    'odontogram',
    'note',
    'signature',
    'birthdate',
    'birth_date',
    'content_html',
    'branch',
    'branches',
    'branchbreakdown',
    'maxbranches',
    'extra_branches',
    'extrabranches',
    'sucursal',
    'sucursales'
];

const SORT_COLUMNS = {
    name: 'b.name',
    active: 'b.active',
    status: 'b.status',
    created_at: 'b.created_at',
    updated_at: 'b.updated_at',
    subscription_status: 'b.subscription_status',
    trial_ends_at: 'b.trial_ends_at',
    plan: 'b.plan',
    total_users: 'total_users',
    active_users: 'active_users',
    last_activity_at: 'last_activity_at'
};

const USER_SORT_COLUMNS = {
    created_at: 'l.created_at',
    updated_at: 'l.updated_at',
    name: 'l.name',
    email: 'l.email',
    active: 'l.active',
    locked: 'l.locked',
    role: 'r.code',
    business_name: 'b.name',
    last_activity_at: 'last_activity_at'
};

const SESSION_SORT_COLUMNS = {
    created_at: 's.created_at',
    updated_at: 's.updated_at',
    active: 's.active',
    last: 's.last',
    user_name: 'l.name',
    email: 'l.email',
    role: 'r.code',
    business_name: 'b.name'
};

const TENANT_COLLATION = 'utf8mb4_unicode_ci';

function toPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePagination(query) {
    const page = toPositiveInteger(query.page, DEFAULT_PAGE);
    const requestedPageSize = toPositiveInteger(query.pageSize, DEFAULT_PAGE_SIZE);
    const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);

    return {
        page,
        pageSize,
        offset: (page - 1) * pageSize
    };
}

function normalizeSort(query) {
    const sortBy = SORT_COLUMNS[query.sortBy] ? query.sortBy : 'created_at';
    const requestedSortDir = typeof query.sortDir === 'string' ? query.sortDir.toLowerCase() : 'desc';
    const sortDir = requestedSortDir === 'asc' ? 'ASC' : 'DESC';

    return {
        sortColumn: SORT_COLUMNS[sortBy],
        sortDir
    };
}

function normalizeUserSort(query) {
    const sortBy = USER_SORT_COLUMNS[query.sortBy] ? query.sortBy : 'created_at';
    const requestedSortDir = typeof query.sortDir === 'string' ? query.sortDir.toLowerCase() : 'desc';
    const sortDir = requestedSortDir === 'asc' ? 'ASC' : 'DESC';

    return {
        sortColumn: USER_SORT_COLUMNS[sortBy],
        sortDir
    };
}

function normalizeSessionSort(query) {
    const sortBy = SESSION_SORT_COLUMNS[query.sortBy] ? query.sortBy : 'created_at';
    const requestedSortDir = typeof query.sortDir === 'string' ? query.sortDir.toLowerCase() : 'desc';
    const sortDir = requestedSortDir === 'asc' ? 'ASC' : 'DESC';

    return {
        sortColumn: SESSION_SORT_COLUMNS[sortBy],
        sortDir
    };
}

function normalizeAuditPagination(query) {
    const page = toPositiveInteger(query.page, DEFAULT_PAGE);
    const requestedLimit = toPositiveInteger(query.limit || query.pageSize, DEFAULT_PAGE_SIZE);
    const limit = Math.min(requestedLimit, MAX_PAGE_SIZE);

    return {
        page,
        limit,
        offset: (page - 1) * limit
    };
}

function normalizeActive(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const normalized = String(value).toLowerCase();
    if (['1', 'true', 'active'].includes(normalized)) {
        return 1;
    }

    if (['0', 'false', 'inactive'].includes(normalized)) {
        return 0;
    }

    return null;
}

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalString(value) {
    const normalized = normalizeString(value);
    return normalized || null;
}

function normalizeSlug(value) {
    return normalizeString(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

function normalizeBusinessStatus(value) {
    const status = normalizeString(value).toLowerCase();
    return BUSINESS_STATUSES.includes(status) ? status : 'active';
}

function normalizeCreateSubscriptionStatus(value) {
    const status = normalizeString(value || 'trial').toLowerCase();
    return CREATE_SUBSCRIPTION_STATUSES.includes(status) ? status : null;
}

function normalizeTrialDays(value) {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_TRIAL_DAYS;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        return null;
    }

    if (parsed < MIN_TRIAL_DAYS || parsed > MAX_TRIAL_DAYS) {
        return null;
    }

    return parsed;
}

function normalizeDateTimeInput(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return false;
    }

    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value).toLowerCase();
    if (['1', 'true', 'active', 'yes', 'si'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'inactive', 'no'].includes(normalized)) {
        return false;
    }

    return fallback;
}

function created(data, message) {
    return {
        status: CREATED_STATUS,
        data,
        message
    };
}

function conflict(message, data = null) {
    return {
        status: CONFLICT_STATUS,
        data,
        message
    };
}

function isDateOnly(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatDateOnly(date) {
    return date.toISOString().slice(0, 10);
}

function trialDaysRemaining(subscriptionStatus, trialEndsAt) {
    if (subscriptionStatus !== 'trial' || !trialEndsAt) {
        return null;
    }

    const end = new Date(trialEndsAt);
    if (Number.isNaN(end.getTime())) {
        return null;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);

    return Math.max(Math.ceil((end.getTime() - today.getTime()) / 86400000), 0);
}

function isTrialExpired(subscriptionStatus, trialEndsAt) {
    if (subscriptionStatus !== 'trial' || !trialEndsAt) {
        return false;
    }

    const end = new Date(trialEndsAt);
    return !Number.isNaN(end.getTime()) && end < new Date();
}

function normalizeDashboardRange(query) {
    if (query.from && !isDateOnly(query.from)) {
        return { error: responseData.bad_request('El parametro from debe tener formato YYYY-MM-DD.') };
    }

    if (query.to && !isDateOnly(query.to)) {
        return { error: responseData.bad_request('El parametro to debe tener formato YYYY-MM-DD.') };
    }

    const today = new Date();
    const defaultFrom = new Date(today);
    defaultFrom.setDate(defaultFrom.getDate() - 30);

    const from = query.from || formatDateOnly(defaultFrom);
    const to = query.to || formatDateOnly(today);

    if (from > to) {
        return { error: responseData.bad_request('El parametro from no puede ser mayor que to.') };
    }

    return {
        from,
        to,
        fromDateTime: `${from} 00:00:00`,
        toDateTime: `${to} 23:59:59`,
        businessId: query.businessId && String(query.businessId).trim() ? String(query.businessId).trim() : null
    };
}

function businessScope(column) {
    return `${column} COLLATE ${TENANT_COLLATION} = :_dashboard_business_id COLLATE ${TENANT_COLLATION}`;
}

function rangeScope(column) {
    return `${column} >= :_dashboard_from AND ${column} <= :_dashboard_to`;
}

function buildBusinessFilters(query) {
    const where = [];
    const replacements = {};

    if (query.search && String(query.search).trim()) {
        replacements._search = `%${String(query.search).trim()}%`;
        where.push(`(
            b.name LIKE :_search
            OR b.legal_name LIKE :_search
            OR b.slug LIKE :_search
            OR b.email LIKE :_search
            OR b.phone LIKE :_search
        )`);
    }

    const active = normalizeActive(query.active);
    if (active !== null) {
        replacements._active = active;
        where.push('b.active = :_active');
    }

    if (query.status && String(query.status).trim()) {
        replacements._status = String(query.status).trim();
        where.push('b.status = :_status');
    }

    if (query.subscriptionStatus && String(query.subscriptionStatus).trim()) {
        const subscriptionStatus = String(query.subscriptionStatus).trim().toLowerCase();
        if (SUBSCRIPTION_STATUSES.includes(subscriptionStatus)) {
            replacements._subscription_status = subscriptionStatus;
            where.push('b.subscription_status = :_subscription_status');
        }
    }

    if (query.trialState && String(query.trialState).trim()) {
        const trialState = String(query.trialState).trim().toLowerCase();
        if (TRIAL_STATES.includes(trialState)) {
            where.push("b.subscription_status = 'trial'");

            if (trialState === 'active') {
                where.push('b.trial_ends_at >= NOW()');
            } else if (trialState === 'expired') {
                where.push('b.trial_ends_at < NOW()');
            } else if (trialState === 'expiring_soon') {
                where.push('b.trial_ends_at >= NOW()');
                where.push('b.trial_ends_at <= DATE_ADD(NOW(), INTERVAL 7 DAY)');
            }
        }
    }

    if (query.plan && String(query.plan).trim()) {
        replacements._plan = String(query.plan).trim();
        where.push('b.plan COLLATE utf8mb4_unicode_ci = :_plan COLLATE utf8mb4_unicode_ci');
    }

    if (isDateOnly(query.from)) {
        replacements._from = query.from;
        where.push('b.created_at >= :_from');
    }

    if (isDateOnly(query.to)) {
        replacements._to = `${query.to} 23:59:59`;
        where.push('b.created_at <= :_to');
    }

    return {
        whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
        replacements
    };
}

function buildUserFilters(query) {
    const where = [];
    const replacements = {};

    if (query.search && String(query.search).trim()) {
        replacements._user_search = `%${String(query.search).trim()}%`;
        where.push(`(
            l.name LIKE :_user_search
            OR l.email LIKE :_user_search
            OR l.telephone LIKE :_user_search
            OR l.id_login LIKE :_user_search
            OR r.code LIKE :_user_search
            OR b.name LIKE :_user_search
        )`);
    }

    if (query.businessId && String(query.businessId).trim()) {
        replacements._business_id = String(query.businessId).trim();
        where.push('l.id_business COLLATE utf8mb4_unicode_ci = :_business_id COLLATE utf8mb4_unicode_ci');
    }

    if (query.role && String(query.role).trim()) {
        replacements._role = String(query.role).trim();
        where.push('r.code COLLATE utf8mb4_unicode_ci = :_role COLLATE utf8mb4_unicode_ci');
    }

    const active = normalizeActive(query.active);
    if (active !== null) {
        replacements._user_active = active;
        where.push('l.active = :_user_active');
    }

    const locked = normalizeActive(query.locked);
    if (locked !== null) {
        replacements._user_locked = locked;
        where.push('l.locked = :_user_locked');
    }

    if (isDateOnly(query.from)) {
        replacements._user_from = query.from;
        where.push('l.created_at >= :_user_from');
    }

    if (isDateOnly(query.to)) {
        replacements._user_to = `${query.to} 23:59:59`;
        where.push('l.created_at <= :_user_to');
    }

    return {
        whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
        replacements
    };
}

function buildSessionFilters(query) {
    const where = [];
    const replacements = {};

    if (query.search && String(query.search).trim()) {
        replacements._session_search = `%${String(query.search).trim()}%`;
        where.push(`(
            s.id_session LIKE :_session_search
            OR l.name LIKE :_session_search
            OR l.email LIKE :_session_search
            OR l.id_login LIKE :_session_search
            OR r.code LIKE :_session_search
            OR b.name LIKE :_session_search
        )`);
    }

    if (query.businessId && String(query.businessId).trim()) {
        replacements._session_business_id = String(query.businessId).trim();
        where.push('l.id_business COLLATE utf8mb4_unicode_ci = :_session_business_id COLLATE utf8mb4_unicode_ci');
    }

    if (query.role && String(query.role).trim()) {
        replacements._session_role = String(query.role).trim();
        where.push('r.code COLLATE utf8mb4_unicode_ci = :_session_role COLLATE utf8mb4_unicode_ci');
    }

    const hasActiveFilter = query.active !== undefined && query.active !== null && query.active !== '';
    const activeFilter = hasActiveFilter ? String(query.active).trim().toLowerCase() : '';
    const active = normalizeActive(query.active);
    if (activeFilter === 'all') {
        // Sin filtro de estado: permite consultar activas e inactivas desde el modulo global.
    } else if (active !== null) {
        replacements._session_active = active;
        where.push('s.active = :_session_active');
    } else {
        where.push('s.active = 1');
        where.push('s.last = 1');
    }

    if (isDateOnly(query.from)) {
        replacements._session_from = query.from;
        where.push('s.created_at >= :_session_from');
    }

    if (isDateOnly(query.to)) {
        replacements._session_to = `${query.to} 23:59:59`;
        where.push('s.created_at <= :_session_to');
    }

    return {
        whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
        replacements
    };
}

function buildAuditFilters(query) {
    const where = [];
    const replacements = {};

    if (query.search && String(query.search).trim()) {
        replacements._audit_search = `%${String(query.search).trim()}%`;
        where.push(`(
            aal.action LIKE :_audit_search
            OR aal.actor_login_id LIKE :_audit_search
            OR aal.target_login_id LIKE :_audit_search
            OR aal.target_business_id LIKE :_audit_search
            OR actor.name LIKE :_audit_search
            OR actor.email LIKE :_audit_search
            OR target.name LIKE :_audit_search
            OR target.email LIKE :_audit_search
            OR b.name LIKE :_audit_search
        )`);
    }

    if (query.action && String(query.action).trim()) {
        const action = String(query.action).trim();
        if (!ADMIN_AUDIT_ACTIONS.includes(action)) {
            return { error: responseData.bad_request('Accion de auditoria invalida.') };
        }
        replacements._audit_action = action;
        where.push('aal.action = :_audit_action');
    }

    if (query.businessId && String(query.businessId).trim()) {
        replacements._audit_business_id = String(query.businessId).trim();
        where.push('aal.target_business_id COLLATE utf8mb4_unicode_ci = :_audit_business_id COLLATE utf8mb4_unicode_ci');
    }

    if (query.actorUserId && String(query.actorUserId).trim()) {
        replacements._audit_actor_user_id = String(query.actorUserId).trim();
        where.push('aal.actor_login_id COLLATE utf8mb4_unicode_ci = :_audit_actor_user_id COLLATE utf8mb4_unicode_ci');
    }

    if (query.targetUserId && String(query.targetUserId).trim()) {
        replacements._audit_target_user_id = String(query.targetUserId).trim();
        where.push('aal.target_login_id COLLATE utf8mb4_unicode_ci = :_audit_target_user_id COLLATE utf8mb4_unicode_ci');
    }

    if (query.from) {
        if (!isDateOnly(query.from)) {
            return { error: responseData.bad_request('El parametro from debe tener formato YYYY-MM-DD.') };
        }
        replacements._audit_from = `${query.from} 00:00:00`;
        where.push('aal.created_at >= :_audit_from');
    }

    if (query.to) {
        if (!isDateOnly(query.to)) {
            return { error: responseData.bad_request('El parametro to debe tener formato YYYY-MM-DD.') };
        }
        replacements._audit_to = `${query.to} 23:59:59`;
        where.push('aal.created_at <= :_audit_to');
    }

    if (query.from && query.to && query.from > query.to) {
        return { error: responseData.bad_request('El parametro from no puede ser mayor que to.') };
    }

    return {
        whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
        replacements
    };
}

function forbidden(message) {
    return {
        status: 403,
        data: null,
        message
    };
}

function notFound(message) {
    return {
        status: 404,
        data: null,
        message
    };
}

function normalizeSubscriptionStatus(value) {
    const status = normalizeString(value).toLowerCase();
    return SUBSCRIPTION_STATUSES.includes(status) ? status : null;
}

function normalizePlan(value) {
    const plan = normalizeString(value).toLowerCase();
    return isValidSaasPlan(plan) ? plan : null;
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

function buildPlanResponse(planCode) {
    return getSaasPlan(planCode) || getUnknownSaasPlan(planCode);
}

function buildPublicPlanResponse(planInput) {
    const plan = typeof planInput === 'string' ? buildPlanResponse(planInput) : (planInput || buildPlanResponse(null));
    const { maxBranches, ...publicPlan } = plan;
    const maxStaffUsers = publicPlan.maxStaffUsers === undefined ? publicPlan.maxAuxiliaryUsers : publicPlan.maxStaffUsers;

    return {
        ...publicPlan,
        maxStaffUsers,
        limits: {
            maxProfessionals: publicPlan.maxProfessionals,
            maxStaffUsers,
            patientsLimit: publicPlan.patientsLimit
        },
        legacy: {
            maxAuxiliaryUsers: publicPlan.maxAuxiliaryUsers
        }
    };
}

function normalizeReason(value) {
    const reason = normalizeOptionalString(value);
    return reason ? reason.replace(/[\r\n\t]+/g, ' ').slice(0, 500) : null;
}

function normalizeSessionClosureOptions(payload = {}, defaultReason) {
    const reason = normalizeReason(payload.reason);
    const confirmation = normalizeOptionalString(payload.confirmation);

    if (confirmation && confirmation !== SESSION_CLOSE_CONFIRMATION) {
        return {
            error: responseData.bad_request('Confirmacion invalida para cierre de sesiones.')
        };
    }

    return {
        reason: reason || defaultReason,
        confirmationProvided: Boolean(confirmation),
        reauthRequiredConfigured: SecurityConfig.isSuperAdminSessionReauthRequired()
    };
}

function normalizeOverrideInteger(value, field) {
    if (value === undefined || value === null || value === '') {
        return 0;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        return { error: `${field} debe ser un entero.` };
    }

    if (parsed < 0) {
        return { error: `${field} no puede ser negativo.` };
    }

    if (parsed > LICENSE_OVERRIDE_LIMITS[field]) {
        return { error: `${field} excede el maximo permitido.` };
    }

    return parsed;
}

function normalizeLicenseOverridePayload(payload = {}) {
    const invalidFields = Object.keys(payload).filter((key) => !LICENSE_OVERRIDE_ALLOWED_FIELDS.includes(key));
    if (invalidFields.length) {
        return {
            error: responseData.bad_request(`Campos no permitidos para extras de licencia: ${invalidFields.join(', ')}.`)
        };
    }

    const extraProfessionals = normalizeOverrideInteger(
        payload.extra_professionals !== undefined ? payload.extra_professionals : payload.extraProfessionals,
        'extra_professionals'
    );
    const extraAuxiliaryUsers = normalizeOverrideInteger(
        payload.extra_auxiliary_users !== undefined ? payload.extra_auxiliary_users : payload.extraAuxiliaryUsers,
        'extra_auxiliary_users'
    );
    const extraBranches = 0;

    const integerError = [extraProfessionals, extraAuxiliaryUsers, extraBranches].find((value) => value && value.error);
    if (integerError) {
        return { error: responseData.bad_request(integerError.error) };
    }

    const reason = normalizeReason(payload.reason);
    if ((extraProfessionals > 0 || extraAuxiliaryUsers > 0) && !reason) {
        return { error: responseData.bad_request('El motivo es obligatorio cuando se asignan extras de licencia.') };
    }

    const validUntilInput = payload.valid_until !== undefined ? payload.valid_until : payload.validUntil;
    const normalizedValidUntilInput = typeof validUntilInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(validUntilInput)
        ? `${validUntilInput} 23:59:59`
        : validUntilInput;
    const validUntil = normalizeDateTimeInput(normalizedValidUntilInput);
    if (validUntil === false) {
        return { error: responseData.bad_request('La vigencia debe tener un formato de fecha valido.') };
    }

    return {
        overrides: {
            extra_professionals: extraProfessionals,
            extra_auxiliary_users: extraAuxiliaryUsers,
            extra_branches: extraBranches,
            reason,
            valid_until: validUntil
        }
    };
}

function mapLicenseOverrideResponse(override, idBusiness = null) {
    return {
        id: override && override.id ? override.id : null,
        id_business: override && override.id_business ? override.id_business : idBusiness,
        extra_professionals: Number(override && override.extra_professionals ? override.extra_professionals : 0),
        extra_auxiliary_users: Number(override && override.extra_auxiliary_users ? override.extra_auxiliary_users : 0),
        reason: override && override.reason ? override.reason : null,
        valid_until: override && override.valid_until ? override.valid_until : null,
        expired: Boolean(override && override.expired),
        created_at: override && override.created_at ? override.created_at : null,
        updated_at: override && override.updated_at ? override.updated_at : null
    };
}

function normalizeRequiredDays(value, maxDays = MAX_TRIAL_DAYS) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        return null;
    }

    if (parsed < MIN_TRIAL_DAYS || parsed > maxDays) {
        return null;
    }

    return parsed;
}

function normalizeLimitedText(value, maxLength, allowNull = true) {
    const normalized = normalizeString(value);
    if (!normalized) {
        return allowNull ? null : '';
    }

    return normalized.slice(0, maxLength);
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isValidPhone(value) {
    const phone = String(value || '').trim();
    return phone.length >= 6 && phone.length <= 50 && /^[0-9+().\-\s]+$/.test(phone);
}

function isValidSlug(value) {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || '').trim());
}

function normalizeBusinessUpdatePayload(payload = {}) {
    const keys = Object.keys(payload || {});
    if (!keys.length) {
        return {
            error: responseData.bad_request('Debes enviar al menos un campo editable.')
        };
    }

    const blockedField = keys.find((key) => BUSINESS_UPDATE_BLOCKED_FIELDS.includes(key));
    if (blockedField) {
        return {
            error: responseData.bad_request(`El campo ${blockedField} no puede editarse desde este endpoint.`)
        };
    }

    const unknownField = keys.find((key) => !BUSINESS_UPDATE_ALLOWED_FIELDS.includes(key));
    if (unknownField) {
        return {
            error: responseData.bad_request(`El campo ${unknownField} no esta permitido para edicion basica.`)
        };
    }

    const updates = {};

    if (Object.prototype.hasOwnProperty.call(payload, 'name')) {
        const name = normalizeLimitedText(payload.name, 500, false);
        if (!name) {
            return { error: responseData.bad_request('El nombre del negocio es obligatorio.') };
        }
        updates.name = name;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'legalName') || Object.prototype.hasOwnProperty.call(payload, 'legal_name')) {
        updates.legal_name = normalizeLimitedText(payload.legalName !== undefined ? payload.legalName : payload.legal_name, 500, true);
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'slug')) {
        const slug = normalizeString(payload.slug);
        if (!slug) {
            return { error: responseData.bad_request('El slug no puede quedar vacio.') };
        }
        if (slug !== normalizeSlug(slug) || !isValidSlug(slug)) {
            return { error: responseData.bad_request('El slug debe estar en minusculas, sin espacios y usar solo letras, numeros y guiones.') };
        }
        if (slug.length > 120) {
            return { error: responseData.bad_request('El slug no puede exceder 120 caracteres.') };
        }
        updates.slug = slug;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'email')) {
        const email = normalizeLimitedText(payload.email, 500, true);
        if (email && !isValidEmail(email)) {
            return { error: responseData.bad_request('El correo del negocio no tiene un formato valido.') };
        }
        updates.email = email;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'phone')) {
        const phone = normalizeLimitedText(payload.phone, 50, true);
        if (phone && !isValidPhone(phone)) {
            return { error: responseData.bad_request('El telefono del negocio no tiene un formato valido.') };
        }
        updates.phone = phone;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'address')) {
        updates.address = normalizeLimitedText(payload.address, 1000, true);
    }

    if (!Object.keys(updates).length) {
        return {
            error: responseData.bad_request('Debes enviar al menos un campo editable.')
        };
    }

    return { updates };
}

function formatDateTime(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

function hasSensitiveMetadataKey(key) {
    const normalized = String(key || '').toLowerCase();
    return SENSITIVE_METADATA_KEYS.some((sensitive) => normalized.includes(sensitive));
}

function sanitizeMetadataValue(value, depth = 0) {
    if (depth > 2) {
        return '[max_depth]';
    }

    if (value === null || value === undefined) {
        return null;
    }

    if (['string', 'number', 'boolean'].includes(typeof value)) {
        return typeof value === 'string' ? value.slice(0, 500) : value;
    }

    if (Array.isArray(value)) {
        return value.slice(0, 20).map((item) => sanitizeMetadataValue(item, depth + 1));
    }

    if (typeof value === 'object') {
        const sanitized = {};
        Object.keys(value).slice(0, 30).forEach((key) => {
            if (!hasSensitiveMetadataKey(key)) {
                sanitized[key] = sanitizeMetadataValue(value[key], depth + 1);
            }
        });
        return sanitized;
    }

    return null;
}

function sanitizeMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return sanitizeMetadataValue(value);
}

function parseAndSanitizeMetadata(value) {
    if (!value) {
        return {};
    }

    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return sanitizeMetadata(parsed);
    } catch (error) {
        return {};
    }
}

function businessAuditAction(previousStatus, nextStatus) {
    if (nextStatus === 'suspended') {
        return 'SUPER_ADMIN_BUSINESS_SUSPEND';
    }

    if (nextStatus === 'cancelled') {
        return 'SUPER_ADMIN_BUSINESS_CANCEL';
    }

    if (nextStatus === 'active' && ['suspended', 'cancelled', 'past_due'].includes(previousStatus)) {
        return 'SUPER_ADMIN_BUSINESS_REACTIVATE';
    }

    return 'SUPER_ADMIN_BUSINESS_STATUS_CHANGE';
}

async function getBusinessById(idBusiness, transaction, forUpdate = false) {
    const rows = await sequelize.query(
        `SELECT
                id_business,
                name,
                legal_name,
                slug,
                email,
                phone,
                address,
                active,
                status,
                subscription_status,
                trial_starts_at,
                trial_ends_at,
                current_period_starts_at,
                current_period_ends_at,
                suspended_at,
                cancelled_at,
                status_reason,
                plan,
                created_at,
                updated_at
           FROM business
          WHERE id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}
          LIMIT 1 ${forUpdate ? 'FOR UPDATE' : ''}`,
        {
            replacements: {
                _id_business: idBusiness
            },
            type: QueryTypes.SELECT,
            transaction
        }
    );

    return rows && rows[0] ? rows[0] : null;
}

function mapBusinessCommercial(row) {
    if (!row) {
        return null;
    }

    const subscriptionStatus = row.subscription_status || null;
    const operational = isBusinessOperational({
        active: row.active,
        subscription_status: subscriptionStatus,
        trial_ends_at: row.trial_ends_at
    });

    return {
        id_business: row.id_business,
        name: row.name,
        legal_name: row.legal_name || null,
        slug: row.slug || null,
        email: row.email || null,
        phone: row.phone || null,
        address: row.address || null,
        active: row.active === true || row.active === 1,
        status: row.status || null,
        subscription_status: subscriptionStatus,
        plan: row.plan || null,
        plan_label: getPlanLabel(row.plan),
        plan_limits_summary: getPlanLimitsSummary(row.plan),
        trial_starts_at: row.trial_starts_at || null,
        trial_ends_at: row.trial_ends_at || null,
        current_period_starts_at: row.current_period_starts_at || null,
        current_period_ends_at: row.current_period_ends_at || null,
        suspended_at: row.suspended_at || null,
        cancelled_at: row.cancelled_at || null,
        status_reason: row.status_reason || null,
        trial_days_remaining: trialDaysRemaining(subscriptionStatus, row.trial_ends_at),
        is_trial_expired: isTrialExpired(subscriptionStatus, row.trial_ends_at),
        is_operational: operational.allowed === true,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null
    };
}

async function buildBusinessListLicenseSummary(idBusiness) {
    const license = await getBusinessEffectiveLicense(idBusiness);
    if (!license) {
        return null;
    }

    const usage = license.usage || {};
    const effectiveLimits = license.effectiveLimits || {};
    const auxiliaryUsers = Number(usage.auxiliaryUsers || 0);
    const staffUsers = Number(usage.staffUsers === undefined ? auxiliaryUsers : usage.staffUsers);
    const staffLimit = effectiveLimits.staffUsers === undefined ? effectiveLimits.auxiliaryUsers : effectiveLimits.staffUsers;

    return {
        plan: license.plan && license.plan.code ? license.plan.code : null,
        planLabel: license.plan && license.plan.name ? license.plan.name : null,
        professionals: buildLimitUsage(Number(usage.professionals || 0), effectiveLimits.professionals),
        staffUsers: buildLimitUsage(staffUsers, staffLimit),
        patients: {
            used: null,
            limit: null,
            remaining: null,
            exceeded: false,
            fairUse: true,
            label: 'Pacientes ilimitados'
        }
    };
}

class SuperAdminDao {
    async audit(query = {}) {
        try {
            const pagination = normalizeAuditPagination(query);
            const filters = buildAuditFilters(query);
            if (filters.error) {
                return filters.error;
            }

            const fromSql = `FROM admin_audit_log aal
                   LEFT JOIN login actor
                          ON actor.id_login COLLATE utf8mb4_unicode_ci = aal.actor_login_id COLLATE utf8mb4_unicode_ci
                   LEFT JOIN login target
                          ON target.id_login COLLATE utf8mb4_unicode_ci = aal.target_login_id COLLATE utf8mb4_unicode_ci
                   LEFT JOIN business b
                          ON b.id_business COLLATE utf8mb4_unicode_ci = aal.target_business_id COLLATE utf8mb4_unicode_ci
                  ${filters.whereSql}`;

            const countRows = await sequelize.query(
                `SELECT COUNT(*) AS total ${fromSql}`,
                {
                    replacements: filters.replacements,
                    type: QueryTypes.SELECT
                }
            );

            const total = Number(countRows && countRows[0] ? countRows[0].total : 0);
            const totalPages = total > 0 ? Math.ceil(total / pagination.limit) : 0;

            const rows = await sequelize.query(
                `SELECT
                    aal.id_admin_audit_log AS id,
                    aal.action,
                    aal.actor_login_id AS actor_user_id,
                    actor.name AS actor_name,
                    actor.email AS actor_email,
                    aal.actor_role,
                    aal.target_business_id AS business_id,
                    b.name AS business_name,
                    aal.target_login_id AS target_user_id,
                    target.email AS target_user_email,
                    target.name AS target_user_name,
                    aal.target_type,
                    aal.target_id,
                    aal.metadata_json,
                    aal.created_at
                   ${fromSql}
                  ORDER BY aal.created_at DESC
                  LIMIT :_limit OFFSET :_offset`,
                {
                    replacements: {
                        ...filters.replacements,
                        _limit: pagination.limit,
                        _offset: pagination.offset
                    },
                    type: QueryTypes.SELECT
                }
            );

            const data = rows.map((row) => ({
                id: row.id,
                action: row.action,
                actor_user_id: row.actor_user_id || null,
                actor_name: row.actor_name || null,
                actor_email: row.actor_email || null,
                actor_role: row.actor_role || null,
                business_id: row.business_id || null,
                business_name: row.business_name || null,
                target_user_id: row.target_user_id || null,
                target_user_email: row.target_user_email || null,
                target_user_name: row.target_user_name || null,
                target_type: row.target_type || null,
                target_id: row.target_id || null,
                created_at: row.created_at || null,
                metadata: parseAndSanitizeMetadata(row.metadata_json)
            }));

            return responseData.success({
                data,
                pagination: {
                    page: pagination.page,
                    limit: pagination.limit,
                    total,
                    totalPages
                },
                filters: {
                    actions: ADMIN_AUDIT_ACTIONS
                }
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async plans() {
        try {
            return responseData.success({
                plans: getSaasPlans().map(buildPublicPlanResponse)
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async businessLicenseSummary(idBusiness) {
        try {
            if (!idBusiness) {
                return responseData.bad_request('Negocio requerido.');
            }

            const businesses = await sequelize.query(
                `SELECT
                    id_business,
                    name,
                    plan,
                    subscription_status,
                    active,
                    status
                   FROM business
                  WHERE id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}
                  LIMIT 1`,
                {
                    replacements: {
                        _id_business: idBusiness
                    },
                    type: QueryTypes.SELECT
                }
            );

            const business = businesses[0];
            if (!business) {
                return notFound('Negocio no encontrado.');
            }

            const license = await getBusinessEffectiveLicense(idBusiness);
            const internalPlan = license ? license.plan : buildPlanResponse(business.plan);
            const plan = buildPublicPlanResponse(internalPlan);
            const usage = license ? license.usage : { professionals: 0, auxiliaryUsers: 0, staffUsers: 0 };
            const overrides = license ? license.overrides : await LicenseUsageDao.getBusinessLicenseOverride(idBusiness);
            const professionals = Number(usage.professionals || 0);
            const auxiliaryUsers = Number(usage.auxiliaryUsers || 0);
            const staffUsers = Number(usage.staffUsers === undefined ? auxiliaryUsers : usage.staffUsers);
            const planLimits = {
                professionals: license ? license.planLimits.professionals : internalPlan.maxProfessionals,
                staffUsers: license
                    ? (license.planLimits.staffUsers === undefined ? license.planLimits.auxiliaryUsers : license.planLimits.staffUsers)
                    : (internalPlan.maxStaffUsers === undefined ? internalPlan.maxAuxiliaryUsers : internalPlan.maxStaffUsers),
                auxiliaryUsers: license ? license.planLimits.auxiliaryUsers : internalPlan.maxAuxiliaryUsers,
                patientsLimit: internalPlan.patientsLimit
            };
            const effectiveLimits = license ? {
                professionals: license.effectiveLimits.professionals,
                staffUsers: license.effectiveLimits.staffUsers === undefined ? license.effectiveLimits.auxiliaryUsers : license.effectiveLimits.staffUsers,
                auxiliaryUsers: license.effectiveLimits.auxiliaryUsers
            } : {
                professionals: internalPlan.maxProfessionals,
                auxiliaryUsers: internalPlan.maxAuxiliaryUsers,
                staffUsers: internalPlan.maxStaffUsers === undefined ? internalPlan.maxAuxiliaryUsers : internalPlan.maxStaffUsers
            };

            return responseData.success({
                business: {
                    id: business.id_business,
                    id_business: business.id_business,
                    name: business.name || null,
                    plan: business.plan || null,
                    subscription_status: business.subscription_status || null,
                    active: business.active === true || business.active === 1,
                    status: business.status || null
                },
                plan,
                usage: {
                    professionals,
                    staffUsers,
                    auxiliaryUsers
                },
                planLimits,
                overrides: {
                    extraProfessionals: Number(overrides.extra_professionals || 0),
                    extraAuxiliaryUsers: Number(overrides.extra_auxiliary_users || 0),
                    extra_professionals: Number(overrides.extra_professionals || 0),
                    extra_auxiliary_users: Number(overrides.extra_auxiliary_users || 0),
                    reason: overrides.reason || null,
                    validUntil: overrides.valid_until || null,
                    valid_until: overrides.valid_until || null,
                    expired: Boolean(overrides.expired)
                },
                effectiveLimits,
                limits: {
                    professionals: buildLimitUsage(professionals, effectiveLimits.professionals),
                    staffUsers: buildLimitUsage(staffUsers, effectiveLimits.staffUsers === undefined ? effectiveLimits.auxiliaryUsers : effectiveLimits.staffUsers),
                    auxiliaryUsers: buildLimitUsage(auxiliaryUsers, effectiveLimits.auxiliaryUsers),
                    patients: {
                        used: null,
                        limit: null,
                        remaining: null,
                        exceeded: false,
                        fairUse: true,
                        label: 'Ilimitados con uso razonable'
                    }
                },
                notes: {
                    professionals: 'Conteo conservador: usuarios activos con rol profesional o perfil profesional activo.',
                    staffUsers: 'Campo canonico publico para usuarios internos activos no globales sin rol/perfil profesional.',
                    auxiliaryUsers: 'Alias legacy de staffUsers conservado temporalmente por compatibilidad.',
                    patients: 'No se cuentan pacientes ni se aplica limite duro en esta fase.'
                }
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async businessLicenseOverrides(idBusiness) {
        try {
            if (!idBusiness) {
                return responseData.bad_request('Negocio requerido.');
            }

            const business = await getBusinessById(idBusiness);
            if (!business) {
                return notFound('Negocio no encontrado.');
            }

            const override = await LicenseUsageDao.getBusinessLicenseOverride(idBusiness);
            return responseData.success(mapLicenseOverrideResponse(override, idBusiness), Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async updateBusinessLicenseOverrides(idBusiness, payload = {}, actor = {}) {
        const transaction = await sequelize.transaction();

        try {
            if (!idBusiness) {
                await transaction.rollback();
                return responseData.bad_request('Negocio requerido.');
            }

            const normalized = normalizeLicenseOverridePayload(payload);
            if (normalized.error) {
                await transaction.rollback();
                return normalized.error;
            }

            const business = await getBusinessById(idBusiness, transaction, true);
            if (!business) {
                await transaction.rollback();
                return notFound('Negocio no encontrado.');
            }

            const before = await LicenseUsageDao.getBusinessLicenseOverride(idBusiness, {
                transaction,
                forUpdate: true
            });
            const next = normalized.overrides;

            await sequelize.query(
                `INSERT INTO business_license_overrides (
                    id,
                    id_business,
                    extra_professionals,
                    extra_auxiliary_users,
                    extra_branches,
                    reason,
                    valid_until,
                    created_by,
                    updated_by,
                    created_at,
                    updated_at
                ) VALUES (
                    :_id,
                    :_id_business,
                    :_extra_professionals,
                    :_extra_auxiliary_users,
                    :_extra_branches,
                    :_reason,
                    :_valid_until,
                    :_created_by,
                    :_updated_by,
                    NOW(),
                    NOW()
                )
                ON DUPLICATE KEY UPDATE
                    extra_professionals = VALUES(extra_professionals),
                    extra_auxiliary_users = VALUES(extra_auxiliary_users),
                    extra_branches = VALUES(extra_branches),
                    reason = VALUES(reason),
                    valid_until = VALUES(valid_until),
                    updated_by = VALUES(updated_by),
                    updated_at = NOW()`,
                {
                    replacements: {
                        _id: before.id || uuidv4(),
                        _id_business: idBusiness,
                        _extra_professionals: next.extra_professionals,
                        _extra_auxiliary_users: next.extra_auxiliary_users,
                        _extra_branches: next.extra_branches,
                        _reason: next.reason,
                        _valid_until: next.valid_until,
                        _created_by: actor.actorLoginId || null,
                        _updated_by: actor.actorLoginId || null
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            const after = await LicenseUsageDao.getBusinessLicenseOverride(idBusiness, {
                transaction,
                forUpdate: false
            });

            await transaction.commit();

            await AdminAuditDao.record('SUPER_ADMIN_LICENSE_OVERRIDES_UPDATE', {
                actor_login_id: actor.actorLoginId,
                actor_role: actor.actorRole,
                target_type: 'business',
                target_id: idBusiness,
                target_business_id: idBusiness,
                ip: actor.ip,
                user_agent: actor.userAgent,
                metadata: {
                    business_id: idBusiness,
                    previous: {
                        extra_professionals: before.extra_professionals,
                        extra_auxiliary_users: before.extra_auxiliary_users,
                        valid_until: before.valid_until || null
                    },
                    next: {
                        extra_professionals: after.extra_professionals,
                        extra_auxiliary_users: after.extra_auxiliary_users,
                        valid_until: after.valid_until || null
                    },
                    reason: after.reason || null
                }
            });

            const summaryResponse = await this.businessLicenseSummary(idBusiness);

            return responseData.success({
                success: true,
                overrides: mapLicenseOverrideResponse(after, idBusiness),
                licenseSummary: summaryResponse.data || null
            }, 'Extras de licencia actualizados correctamente.');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async monthlyMetric(table, dateColumn, businessColumn, replacements, extraWhere = '') {
        const where = [
            rangeScope(dateColumn)
        ];

        if (replacements._dashboard_business_id) {
            where.push(businessScope(businessColumn));
        }

        if (extraWhere) {
            where.push(extraWhere);
        }

        const rows = await sequelize.query(
            `SELECT DATE_FORMAT(${dateColumn}, '%Y-%m') AS month,
                    COUNT(*) AS total
               FROM ${table}
              WHERE ${where.join(' AND ')}
              GROUP BY DATE_FORMAT(${dateColumn}, '%Y-%m')
              ORDER BY month ASC`,
            {
                replacements,
                type: QueryTypes.SELECT
            }
        );

        return rows.map((row) => ({
            month: row.month,
            total: Number(row.total || 0)
        }));
    }

    async dashboardSummary(query = {}) {
        try {
            const range = normalizeDashboardRange(query);
            if (range.error) {
                return range.error;
            }

            const replacements = {
                _dashboard_from: range.fromDateTime,
                _dashboard_to: range.toDateTime
            };

            if (range.businessId) {
                replacements._dashboard_business_id = range.businessId;
            }

            const {
                businesses,
                activeBusinesses,
                inactiveBusinesses,
                suspendedBusinesses,
                trialBusinesses,
                activeSubscriptionBusinesses,
                pastDueBusinesses,
                suspendedSubscriptionBusinesses,
                cancelledBusinesses,
                expiredTrials,
                trialsExpiringSoon,
                users,
                activeUsers,
                lockedUsers,
                activeSessions,
                newBusinesses,
                newTrialBusinesses,
                newActiveSubscriptionBusinesses,
                newUsers,
                patientsCreated,
                appointmentsCreated,
                prescriptionsCreated,
                clinicalHistoriesCreated,
                businessesWithoutAdmin,
                businessesWithoutActivityLast30Days,
                businessSeries,
                userSeries,
                patientSeries,
                appointmentSeries,
                prescriptionSeries,
                clinicalHistorySeries,
                topBusinessesByUsage
            } = await getDashboardMetrics(replacements, this.monthlyMetric.bind(this));

            return responseData.success({
                totals: {
                    businesses,
                    activeBusinesses,
                    inactiveBusinesses,
                    suspendedBusinesses,
                    trialBusinesses,
                    activeSubscriptionBusinesses,
                    pastDueBusinesses,
                    suspendedSubscriptionBusinesses,
                    cancelledBusinesses,
                    expiredTrials,
                    trialsExpiringSoon,
                    users,
                    activeUsers,
                    lockedUsers,
                    activeSessions
                },
                recent: {
                    newBusinesses,
                    newTrialBusinesses,
                    newActiveSubscriptionBusinesses,
                    convertedToActive: 0,
                    newUsers,
                    businessesWithoutRecentActivity: businessesWithoutActivityLast30Days
                },
                clinicalUsage: {
                    patientsCreated,
                    appointmentsCreated,
                    prescriptionsCreated,
                    clinicalHistoriesCreated
                },
                monthlySeries: {
                    businesses: businessSeries,
                    users: userSeries,
                    patients: patientSeries,
                    appointments: appointmentSeries,
                    prescriptions: prescriptionSeries,
                    clinicalHistories: clinicalHistorySeries
                },
                topBusinessesByUsage: topBusinessesByUsage.map((row) => ({
                    id_business: row.id_business,
                    name: row.name,
                    subscription_status: row.subscription_status || null,
                    plan: row.plan || null,
                    plan_label: getPlanLabel(row.plan),
                    plan_limits_summary: getPlanLimitsSummary(row.plan),
                    trial_ends_at: row.trial_ends_at || null,
                    trial_days_remaining: trialDaysRemaining(row.subscription_status, row.trial_ends_at),
                    users: Number(row.users || 0),
                    patients: Number(row.patients || 0),
                    appointments: Number(row.appointments || 0),
                    prescriptions: Number(row.prescriptions || 0),
                    clinicalHistories: Number(row.clinicalHistories || 0),
                    lastActivityAt: row.lastActivityAt || null
                })),
                alerts: {
                    businessesWithoutAdmin,
                    businessesWithoutActivityLast30Days,
                    lockedUsers,
                    expiredTrials,
                    trialsExpiringNext7Days: trialsExpiringSoon,
                    suspendedBusinesses: suspendedSubscriptionBusinesses,
                    pastDueBusinesses,
                    cancelledBusinesses
                }
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async saasJobsStatus() {
        try {
            const status = await getTrialLifecycleStatus();
            return responseData.success({
                jobsEnabled: status.jobsEnabled,
                trialExpirationJobEnabled: status.trialExpirationJobEnabled,
                mode: status.mode,
                expiringSoonDays: status.expiringSoonDays,
                expiredTrials: status.expiredTrials,
                trialsExpiringSoon: status.trialsExpiringSoon
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async runSaasTrialLifecycleJob(payload = {}) {
        try {
            const dryRun = payload.dryRun !== false;
            const result = await runTrialLifecycleJob({ dryRun });

            return responseData.success({
                job: result.job,
                dryRun: result.dryRun,
                jobsEnabled: result.jobsEnabled,
                trialExpirationJobEnabled: result.trialExpirationJobEnabled,
                mode: result.mode,
                expiringSoonDays: result.expiringSoonDays,
                expiredTrials: result.expiredTrials,
                trialsExpiringSoon: result.trialsExpiringSoon,
                updatedBusinesses: result.updatedBusinesses,
                canMutate: result.canMutate,
                blockedReason: result.blockedReason,
                expiredTrialBusinesses: result.expiredTrialBusinesses,
                trialsExpiringSoonBusinesses: result.trialsExpiringSoonBusinesses,
                updatedBusinessIds: result.updatedBusinessIds
            }, dryRun ? 'Dry-run de ciclo SaaS ejecutado correctamente.' : 'Job de ciclo SaaS ejecutado correctamente.');
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async createBusiness(payload = {}, actor = {}) {
        const provisioning = new BusinessProvisioning(sequelize);
        const transaction = await sequelize.transaction();
        let businessCreated = null;
        let adminCreated = null;

        try {
            const businessInput = payload.business || payload;
            const adminInput = payload.adminUser || {};
            const createAdmin = adminInput.create === true;
            const businessName = normalizeString(businessInput.name);

            if (!businessName) {
                await transaction.rollback();
                return responseData.bad_request('El nombre del negocio es obligatorio.');
            }

            const subscriptionStatus = normalizeCreateSubscriptionStatus(businessInput.subscription_status);
            if (!subscriptionStatus) {
                await transaction.rollback();
                return responseData.bad_request('El estado SaaS inicial debe ser trial o active.');
            }

            const trialDays = normalizeTrialDays(businessInput.trial_days);
            if (subscriptionStatus === 'trial' && trialDays === null) {
                await transaction.rollback();
                return responseData.bad_request('Los dias de prueba deben ser un entero entre 1 y 365.');
            }

            const trialStartsAt = subscriptionStatus === 'trial'
                ? normalizeDateTimeInput(businessInput.trial_starts_at)
                : null;
            const trialEndsAt = subscriptionStatus === 'trial'
                ? normalizeDateTimeInput(businessInput.trial_ends_at)
                : null;

            if (trialStartsAt === false || trialEndsAt === false) {
                await transaction.rollback();
                return responseData.bad_request('Las fechas de trial deben tener un formato valido.');
            }

            const active = normalizeBoolean(businessInput.active, true) ? 1 : 0;
            const status = 'active';
            const plan = normalizeOptionalString(businessInput.plan) || 'basic';
            const slug = normalizeSlug(businessInput.slug || businessName || uuidv4());

            if (!slug) {
                await transaction.rollback();
                return responseData.bad_request('No fue posible generar un slug valido para el negocio.');
            }

            const duplicateBusiness = await sequelize.query(
                `SELECT id_business, name, slug
                   FROM business
                  WHERE LOWER(name) = LOWER(:_name)
                     OR LOWER(slug) = LOWER(:_slug)
                  LIMIT 1`,
                {
                    replacements: {
                        _name: businessName,
                        _slug: slug
                    },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            if (duplicateBusiness.length) {
                await transaction.rollback();
                return conflict('Ya existe un negocio con ese nombre o slug.');
            }

            let adminRole = null;
            if (createAdmin) {
                const adminName = normalizeString(adminInput.name);
                const adminTelephone = normalizeString(adminInput.telephone || adminInput.phone);
                const adminEmail = normalizeOptionalString(adminInput.email);
                const adminPassword = normalizeString(adminInput.password);
                const requestedRole = normalizeString(adminInput.role || 'admin').toLowerCase();

                if (!adminName) {
                    await transaction.rollback();
                    return responseData.bad_request('El nombre del administrador inicial es obligatorio.');
                }

                if (!adminTelephone) {
                    await transaction.rollback();
                    return responseData.bad_request('El telefono del administrador inicial es obligatorio.');
                }

                if (!adminEmail) {
                    await transaction.rollback();
                    return responseData.bad_request('El correo del administrador es obligatorio como dato de contacto.');
                }

                if (adminEmail.length > 254 || !isValidEmail(adminEmail)) {
                    await transaction.rollback();
                    return responseData.bad_request('El correo del administrador no tiene un formato valido.');
                }

                if (!adminPassword || adminPassword.length < 8) {
                    await transaction.rollback();
                    return responseData.bad_request('La contrasena del administrador inicial debe tener al menos 8 caracteres.');
                }

                if (!ADMIN_ROLES_ALLOWED.includes(requestedRole)) {
                    await transaction.rollback();
                    return responseData.bad_request('El rol del administrador inicial debe ser admin o business_admin.');
                }

                const roleRows = await sequelize.query(
                    `SELECT id_rol, code
                       FROM rol
                      WHERE code COLLATE ${TENANT_COLLATION} = :_role COLLATE ${TENANT_COLLATION}
                        AND active = 1
                      LIMIT 1`,
                    {
                        replacements: {
                            _role: requestedRole
                        },
                        type: QueryTypes.SELECT,
                        transaction
                    }
                );

                if (!roleRows.length) {
                    await transaction.rollback();
                    return responseData.bad_request('No existe un rol activo valido para el administrador inicial.');
                }

                adminRole = roleRows[0];

                const duplicateAdmin = await sequelize.query(
                    `SELECT id_login
                       FROM login
                      WHERE active = 1
                        AND (
                            telephone COLLATE ${TENANT_COLLATION} = :_telephone COLLATE ${TENANT_COLLATION}
                            OR email COLLATE ${TENANT_COLLATION} = :_email COLLATE ${TENANT_COLLATION}
                        )
                      LIMIT 1`,
                    {
                        replacements: {
                            _telephone: adminTelephone,
                            _email: adminEmail
                        },
                        type: QueryTypes.SELECT,
                        transaction
                    }
                );

                if (duplicateAdmin.length) {
                    await transaction.rollback();
                    return conflict('Ya existe un usuario activo con ese telefono o correo.');
                }
            }

            const idBusiness = uuidv4();
            await provisioning.business({
                _id_business: idBusiness,
                _name: businessName,
                _legal_name: normalizeOptionalString(businessInput.legalName || businessInput.legal_name),
                _slug: slug,
                _email: normalizeOptionalString(businessInput.email),
                _phone: normalizeOptionalString(businessInput.phone),
                _address: normalizeOptionalString(businessInput.address),
                _status: status,
                _subscription_status: subscriptionStatus,
                _trial_starts_at: trialStartsAt || null,
                _trial_ends_at: trialEndsAt || null,
                _trial_days: subscriptionStatus === 'trial' ? trialDays : DEFAULT_TRIAL_DAYS,
                _plan: plan,
                _active: active,
                _created_by: actor.actorLoginId || null
            }, transaction);
            const defaults = await provisioning.defaults(idBusiness, actor.actorLoginId || null, transaction);

            businessCreated = {
                id_business: idBusiness,
                name: businessName,
                slug,
                active: active === 1,
                status,
                subscription_status: subscriptionStatus,
                trial_starts_at: null,
                trial_ends_at: null,
                plan,
                created_at: null
            };

            if (createAdmin) {
                const adminTelephone = normalizeString(adminInput.telephone || adminInput.phone);
                const adminEmail = normalizeOptionalString(adminInput.email);
                const idLogin = uuidv4();
                const passwordHash = await encript(adminInput.password);

                await provisioning.administrator({
                    _id_login: idLogin,
                    _id_business: idBusiness,
                    _id_rol: adminRole.id_rol,
                    _name: normalizeString(adminInput.name),
                    _email: adminEmail,
                    _telephone: adminTelephone,
                    _password: passwordHash,
                    _created_by: actor.actorLoginId || null
                }, transaction);
                adminCreated = {
                    id_login: idLogin,
                    name: normalizeString(adminInput.name),
                    email: adminEmail,
                    telephone: adminTelephone,
                    role: adminRole.code,
                    active: true
                };
            }

            const createdRows = await sequelize.query(
                `SELECT
                    id_business,
                    name,
                    slug,
                    active,
                    status,
                    subscription_status,
                    trial_starts_at,
                    trial_ends_at,
                    plan,
                    created_at
                   FROM business
                  WHERE id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}
                  LIMIT 1`,
                {
                    replacements: {
                        _id_business: idBusiness
                    },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            const createdBusiness = createdRows[0];
            if (createdBusiness) {
                businessCreated = {
                    id_business: createdBusiness.id_business,
                    name: createdBusiness.name,
                    slug: createdBusiness.slug,
                    active: createdBusiness.active === true || createdBusiness.active === 1,
                    status: createdBusiness.status || null,
                    subscription_status: createdBusiness.subscription_status || null,
                    trial_starts_at: createdBusiness.trial_starts_at || null,
                    trial_ends_at: createdBusiness.trial_ends_at || null,
                    plan: createdBusiness.plan || null,
                    created_at: createdBusiness.created_at || null
                };
            }

            await transaction.commit();

            await AdminAuditDao.record('SUPER_ADMIN_BUSINESS_CREATE', {
                actor_login_id: actor.actorLoginId,
                actor_role: actor.actorRole,
                target_type: 'business',
                target_id: businessCreated.id_business,
                target_login_id: adminCreated ? adminCreated.id_login : null,
                target_business_id: businessCreated.id_business,
                ip: actor.ip,
                user_agent: actor.userAgent,
                metadata: {
                    created_admin: Boolean(adminCreated),
                    admin_login_id: adminCreated ? adminCreated.id_login : null,
                    business_name: businessCreated.name,
                    business_status: businessCreated.status,
                    subscription_status: businessCreated.subscription_status,
                    trial_days: businessCreated.subscription_status === 'trial' ? trialDays : null,
                    trial_starts_at: businessCreated.trial_starts_at,
                    trial_ends_at: businessCreated.trial_ends_at,
                    plan: businessCreated.plan,
                    default_operational_config: {
                        appointment_config: true,
                        ui_theme: defaults.themeCreated
                    }
                }
            });

            return created({
                business: businessCreated,
                adminUser: adminCreated
            }, 'Negocio creado correctamente');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async businessOptions(query = {}) {
        try {
            const pagination = normalizePagination(query);
            const filters = buildBusinessFilters(query);
            const rows = await sequelize.query(
                `SELECT b.id_business, b.name
                   FROM business b
                   ${filters.whereSql}
                   ORDER BY b.name ASC, b.id_business ASC
                   LIMIT :_limit OFFSET :_offset`,
                {
                    replacements: { ...filters.replacements, _limit: pagination.pageSize, _offset: pagination.offset },
                    type: QueryTypes.SELECT
                }
            );
            return responseData.success({ data: rows }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async businesses(query = {}) {
        try {
            const pagination = normalizePagination(query);
            const sort = normalizeSort(query);
            const filters = buildBusinessFilters(query);

            const countRows = await sequelize.query(
                `SELECT COUNT(*) AS total
                   FROM business b
                  ${filters.whereSql}`,
                {
                    replacements: filters.replacements,
                    type: QueryTypes.SELECT
                }
            );

            const total = Number(countRows && countRows[0] ? countRows[0].total : 0);
            const totalPages = total > 0 ? Math.ceil(total / pagination.pageSize) : 0;

            const rows = await sequelize.query(
                `SELECT
                    b.id_business,
                    b.name,
                    b.legal_name,
                    b.slug,
                    b.email,
                    b.phone,
                    b.address,
                    b.active,
                    b.status,
                    b.subscription_status,
                    b.plan,
                    b.trial_starts_at,
                    b.trial_ends_at,
                    b.current_period_starts_at,
                    b.current_period_ends_at,
                    b.suspended_at,
                    b.cancelled_at,
                    b.status_reason,
                    b.created_at,
                    b.updated_at,
                    COUNT(DISTINCT l.id_login) AS total_users,
                    COUNT(DISTINCT CASE WHEN l.active = 1 THEN l.id_login END) AS active_users,
                    MAX(COALESCE(s.updated_at, s.created_at)) AS last_activity_at
                   FROM business b
                   LEFT JOIN login l
                          ON l.id_business COLLATE utf8mb4_unicode_ci = b.id_business COLLATE utf8mb4_unicode_ci
                   LEFT JOIN \`session\` s
                          ON s.id_login COLLATE utf8mb4_unicode_ci = l.id_login COLLATE utf8mb4_unicode_ci
                  ${filters.whereSql}
                  GROUP BY
                    b.id_business,
                    b.name,
                    b.legal_name,
                    b.slug,
                    b.email,
                    b.phone,
                    b.address,
                    b.active,
                    b.status,
                    b.subscription_status,
                    b.plan,
                    b.trial_starts_at,
                    b.trial_ends_at,
                    b.current_period_starts_at,
                    b.current_period_ends_at,
                    b.suspended_at,
                    b.cancelled_at,
                    b.status_reason,
                    b.created_at,
                    b.updated_at
                  ORDER BY ${sort.sortColumn} ${sort.sortDir}
                  LIMIT :_limit OFFSET :_offset`,
                {
                    replacements: {
                        ...filters.replacements,
                        _limit: pagination.pageSize,
                        _offset: pagination.offset
                    },
                    type: QueryTypes.SELECT
                }
            );

            const data = await Promise.all(rows.map(async(row) => ({
                ...(() => {
                    const business = {
                        id_business: row.id_business,
                        active: row.active,
                        subscription_status: row.subscription_status,
                        trial_ends_at: row.trial_ends_at
                    };
                    const operational = isBusinessOperational(business);
                    const subscriptionStatus = row.subscription_status || null;

                    return {
                        id_business: row.id_business,
                        name: row.name,
                        legal_name: row.legal_name || null,
                        slug: row.slug || null,
                        email: row.email || null,
                        phone: row.phone || null,
                        address: row.address || null,
                        active: row.active === true || row.active === 1,
                        status: row.status || null,
                        subscription_status: subscriptionStatus,
                        plan: row.plan || null,
                        plan_label: getPlanLabel(row.plan),
                        plan_limits_summary: getPlanLimitsSummary(row.plan),
                        trial_starts_at: row.trial_starts_at || null,
                        trial_ends_at: row.trial_ends_at || null,
                        current_period_starts_at: row.current_period_starts_at || null,
                        current_period_ends_at: row.current_period_ends_at || null,
                        suspended_at: row.suspended_at || null,
                        cancelled_at: row.cancelled_at || null,
                        status_reason: row.status_reason || null,
                        trial_days_remaining: trialDaysRemaining(subscriptionStatus, row.trial_ends_at),
                        is_trial_expired: isTrialExpired(subscriptionStatus, row.trial_ends_at),
                        is_operational: operational.allowed === true,
                        total_users: Number(row.total_users || 0),
                        active_users: Number(row.active_users || 0),
                        last_activity_at: row.last_activity_at || null,
                        created_at: row.created_at || null,
                        updated_at: row.updated_at || null
                    };
                })(),
                license_summary: await buildBusinessListLicenseSummary(row.id_business)
            })));

            return responseData.success({
                data,
                pagination: {
                    page: pagination.page,
                    pageSize: pagination.pageSize,
                    total,
                    totalPages
                }
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async updateBusiness(idBusiness, payload = {}, actor = {}) {
        const transaction = await sequelize.transaction();
        let before = null;
        let after = null;

        try {
            if (!idBusiness) {
                await transaction.rollback();
                return responseData.bad_request('Negocio requerido.');
            }

            const normalized = normalizeBusinessUpdatePayload(payload);
            if (normalized.error) {
                await transaction.rollback();
                return normalized.error;
            }

            before = await getBusinessById(idBusiness, transaction, true);
            if (!before) {
                await transaction.rollback();
                return notFound('Negocio no encontrado.');
            }

            const updates = normalized.updates;
            const next = {
                name: Object.prototype.hasOwnProperty.call(updates, 'name') ? updates.name : before.name,
                legal_name: Object.prototype.hasOwnProperty.call(updates, 'legal_name') ? updates.legal_name : before.legal_name,
                slug: Object.prototype.hasOwnProperty.call(updates, 'slug') ? updates.slug : before.slug,
                email: Object.prototype.hasOwnProperty.call(updates, 'email') ? updates.email : before.email,
                phone: Object.prototype.hasOwnProperty.call(updates, 'phone') ? updates.phone : before.phone,
                address: Object.prototype.hasOwnProperty.call(updates, 'address') ? updates.address : before.address
            };

            const changedFields = ['name', 'legal_name', 'slug', 'email', 'phone', 'address'].filter((field) => {
                const previousValue = before[field] === undefined ? null : before[field];
                const nextValue = next[field] === undefined ? null : next[field];
                return String(previousValue || '') !== String(nextValue || '');
            });

            if (!changedFields.length) {
                await transaction.rollback();
                return responseData.bad_request('No hay cambios administrativos para guardar.');
            }

            if (changedFields.includes('name') || changedFields.includes('slug')) {
                const duplicateBusiness = await sequelize.query(
                    `SELECT id_business
                       FROM business
                      WHERE id_business COLLATE ${TENANT_COLLATION} != :_id_business COLLATE ${TENANT_COLLATION}
                        AND (
                            LOWER(name) = LOWER(:_name)
                            OR LOWER(slug) = LOWER(:_slug)
                        )
                      LIMIT 1`,
                    {
                        replacements: {
                            _id_business: idBusiness,
                            _name: next.name,
                            _slug: next.slug
                        },
                        type: QueryTypes.SELECT,
                        transaction
                    }
                );

                if (duplicateBusiness.length) {
                    await transaction.rollback();
                    return conflict('Ya existe otro negocio con ese nombre o slug.');
                }
            }

            await sequelize.query(
                `UPDATE business
                    SET name = :_name,
                        legal_name = :_legal_name,
                        slug = :_slug,
                        email = :_email,
                        phone = :_phone,
                        address = :_address,
                        updated_at = NOW(),
                        updated_by = :_updated_by
                  WHERE id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}`,
                {
                    replacements: {
                        _id_business: idBusiness,
                        _name: next.name,
                        _legal_name: next.legal_name,
                        _slug: next.slug,
                        _email: next.email,
                        _phone: next.phone,
                        _address: next.address,
                        _updated_by: actor.actorLoginId || null
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            after = await getBusinessById(idBusiness, transaction, false);
            await transaction.commit();

            const previous = {};
            const current = {};
            changedFields.forEach((field) => {
                previous[field] = before[field] || null;
                current[field] = after[field] || null;
            });

            await AdminAuditDao.record('SUPER_ADMIN_BUSINESS_UPDATE', {
                actor_login_id: actor.actorLoginId,
                actor_role: actor.actorRole,
                target_type: 'business',
                target_id: idBusiness,
                target_business_id: idBusiness,
                ip: actor.ip,
                user_agent: actor.userAgent,
                metadata: {
                    changed_fields: changedFields,
                    previous,
                    current,
                    business_name_before: before.name || null,
                    business_name_after: after.name || null
                }
            });

            return responseData.success({
                success: true,
                business: mapBusinessCommercial(after)
            }, 'Negocio actualizado correctamente');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async users(query = {}) {
        try {
            const pagination = normalizePagination(query);
            const sort = normalizeUserSort(query);
            const filters = buildUserFilters(query);

            const countRows = await sequelize.query(
                `SELECT COUNT(*) AS total
                   FROM login l
                   LEFT JOIN rol r
                          ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci
                   LEFT JOIN business b
                          ON b.id_business COLLATE utf8mb4_unicode_ci = l.id_business COLLATE utf8mb4_unicode_ci
                  ${filters.whereSql}`,
                {
                    replacements: filters.replacements,
                    type: QueryTypes.SELECT
                }
            );

            const total = Number(countRows && countRows[0] ? countRows[0].total : 0);
            const totalPages = total > 0 ? Math.ceil(total / pagination.pageSize) : 0;

            const rows = await sequelize.query(
                `SELECT
                    l.id_login,
                    l.name,
                    l.email,
                    r.code AS role,
                    b.id_business,
                    b.name AS business_name,
                    l.active,
                    l.locked,
                    l.created_at,
                    l.updated_at,
                    MAX(COALESCE(s.updated_at, s.created_at)) AS last_activity_at
                   FROM login l
                   LEFT JOIN rol r
                          ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci
                   LEFT JOIN business b
                          ON b.id_business COLLATE utf8mb4_unicode_ci = l.id_business COLLATE utf8mb4_unicode_ci
                   LEFT JOIN \`session\` s
                          ON s.id_login COLLATE utf8mb4_unicode_ci = l.id_login COLLATE utf8mb4_unicode_ci
                  ${filters.whereSql}
                  GROUP BY
                    l.id_login,
                    l.name,
                    l.email,
                    r.code,
                    b.id_business,
                    b.name,
                    l.active,
                    l.locked,
                    l.created_at,
                    l.updated_at
                  ORDER BY ${sort.sortColumn} ${sort.sortDir}
                  LIMIT :_limit OFFSET :_offset`,
                {
                    replacements: {
                        ...filters.replacements,
                        _limit: pagination.pageSize,
                        _offset: pagination.offset
                    },
                    type: QueryTypes.SELECT
                }
            );

            const data = rows.map((row) => ({
                id_login: row.id_login,
                name: row.name || null,
                email: row.email || null,
                role: row.role || null,
                business: {
                    id_business: row.id_business || null,
                    name: row.business_name || null
                },
                active: row.active === true || row.active === 1,
                locked: row.locked === null || row.locked === undefined ? null : (row.locked === true || row.locked === 1),
                created_at: row.created_at || null,
                updated_at: row.updated_at || null,
                last_activity_at: row.last_activity_at || null
            }));

            return responseData.success({
                data,
                pagination: {
                    page: pagination.page,
                    pageSize: pagination.pageSize,
                    total,
                    totalPages
                }
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async sessions(query = {}) {
        try {
            const pagination = normalizePagination(query);
            const sort = normalizeSessionSort(query);
            const filters = buildSessionFilters(query);

            const countRows = await sequelize.query(
                `SELECT COUNT(*) AS total
                   FROM \`session\` s
                   INNER JOIN login l
                           ON l.id_login COLLATE utf8mb4_unicode_ci = s.id_login COLLATE utf8mb4_unicode_ci
                   LEFT JOIN rol r
                          ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci
                   LEFT JOIN business b
                          ON b.id_business COLLATE utf8mb4_unicode_ci = l.id_business COLLATE utf8mb4_unicode_ci
                  ${filters.whereSql}`,
                {
                    replacements: filters.replacements,
                    type: QueryTypes.SELECT
                }
            );

            const total = Number(countRows && countRows[0] ? countRows[0].total : 0);
            const totalPages = total > 0 ? Math.ceil(total / pagination.pageSize) : 0;

            const rows = await sequelize.query(
                `SELECT
                    s.id_session,
                    s.active,
                    s.last,
                    s.created_at,
                    s.updated_at,
                    s.forze_at,
                    s.forze_by,
                    l.id_login,
                    l.name AS user_name,
                    l.email,
                    r.code AS role,
                    b.id_business,
                    b.name AS business_name
                   FROM \`session\` s
                   INNER JOIN login l
                           ON l.id_login COLLATE utf8mb4_unicode_ci = s.id_login COLLATE utf8mb4_unicode_ci
                   LEFT JOIN rol r
                          ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci
                   LEFT JOIN business b
                          ON b.id_business COLLATE utf8mb4_unicode_ci = l.id_business COLLATE utf8mb4_unicode_ci
                  ${filters.whereSql}
                  ORDER BY ${sort.sortColumn} ${sort.sortDir}
                  LIMIT :_limit OFFSET :_offset`,
                {
                    replacements: {
                        ...filters.replacements,
                        _limit: pagination.pageSize,
                        _offset: pagination.offset
                    },
                    type: QueryTypes.SELECT
                }
            );

            const data = rows.map((row) => ({
                id_session: row.id_session,
                user: {
                    id_login: row.id_login,
                    name: row.user_name || null,
                    email: row.email || null,
                    role: row.role || null
                },
                business: {
                    id_business: row.id_business || null,
                    name: row.business_name || null
                },
                active: row.active === true || row.active === 1,
                last: row.last === true || row.last === 1,
                created_at: row.created_at || null,
                updated_at: row.updated_at || null,
                forced_at: row.forze_at || null,
                forced_by: row.forze_by || null
            }));

            return responseData.success({
                data,
                pagination: {
                    page: pagination.page,
                    pageSize: pagination.pageSize,
                    total,
                    totalPages
                }
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async updateBusinessSubscriptionStatus(idBusiness, payload = {}, actor = {}) {
        const transaction = await sequelize.transaction();
        let before = null;
        let after = null;
        let auditAction = 'SUPER_ADMIN_BUSINESS_STATUS_CHANGE';
        let auditMetadata = {};

        try {
            if (!idBusiness) {
                await transaction.rollback();
                return responseData.bad_request('Negocio requerido.');
            }

            const subscriptionStatus = normalizeSubscriptionStatus(payload.subscription_status);
            if (!subscriptionStatus) {
                await transaction.rollback();
                return responseData.bad_request('Estado comercial invalido.');
            }

            before = await getBusinessById(idBusiness, transaction, true);
            if (!before) {
                await transaction.rollback();
                return notFound('Negocio no encontrado.');
            }

            const reason = normalizeReason(payload.reason);
            if (['past_due', 'suspended', 'cancelled'].includes(subscriptionStatus) && !reason) {
                await transaction.rollback();
                return responseData.bad_request('El motivo es obligatorio para este cambio de estado comercial.');
            }

            const previousStatus = before.subscription_status || null;
            auditAction = businessAuditAction(previousStatus, subscriptionStatus);
            const requestMetadata = sanitizeMetadata(payload.metadata);
            let trialStartsAt = null;
            let trialEndsAt = null;
            let trialDays = null;

            if (subscriptionStatus === 'trial') {
                trialDays = normalizeTrialDays(payload.trial_days);
                if (trialDays === null) {
                    await transaction.rollback();
                    return responseData.bad_request('Los dias de prueba deben ser un entero entre 1 y 365.');
                }

                const requestedTrialStartsAt = normalizeDateTimeInput(payload.trial_starts_at);
                const requestedTrialEndsAt = normalizeDateTimeInput(payload.trial_ends_at);

                if (requestedTrialStartsAt === false || requestedTrialEndsAt === false) {
                    await transaction.rollback();
                    return responseData.bad_request('Las fechas de trial deben tener un formato valido.');
                }

                trialStartsAt = requestedTrialStartsAt || formatDateTime(new Date());
                trialEndsAt = requestedTrialEndsAt || formatDateTime(addDays(new Date(trialStartsAt), trialDays));
            }

            await sequelize.query(
                `UPDATE business
                    SET subscription_status = :_subscription_status,
                        trial_starts_at = CASE
                            WHEN :_subscription_status = 'trial' THEN :_trial_starts_at
                            ELSE trial_starts_at
                        END,
                        trial_ends_at = CASE
                            WHEN :_subscription_status = 'trial' THEN :_trial_ends_at
                            ELSE trial_ends_at
                        END,
                        current_period_starts_at = CASE
                            WHEN :_subscription_status = 'active' THEN COALESCE(current_period_starts_at, NOW())
                            ELSE current_period_starts_at
                        END,
                        suspended_at = CASE
                            WHEN :_subscription_status = 'suspended' THEN NOW()
                            WHEN :_subscription_status IN ('trial', 'active') THEN NULL
                            ELSE suspended_at
                        END,
                        cancelled_at = CASE
                            WHEN :_subscription_status = 'cancelled' THEN NOW()
                            WHEN :_subscription_status IN ('trial', 'active') THEN NULL
                            ELSE cancelled_at
                        END,
                        status_reason = :_status_reason,
                        updated_at = NOW(),
                        updated_by = :_updated_by
                  WHERE id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}`,
                {
                    replacements: {
                        _id_business: idBusiness,
                        _subscription_status: subscriptionStatus,
                        _trial_starts_at: trialStartsAt,
                        _trial_ends_at: trialEndsAt,
                        _status_reason: reason,
                        _updated_by: actor.actorLoginId || null
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            after = await getBusinessById(idBusiness, transaction, false);
            await transaction.commit();

            auditMetadata = {
                previous_subscription_status: previousStatus,
                new_subscription_status: after.subscription_status,
                previous_plan: before.plan || null,
                new_plan: after.plan || null,
                reason,
                trial_days: subscriptionStatus === 'trial' ? trialDays : null,
                trial_ends_at_before: before.trial_ends_at || null,
                trial_ends_at_after: after.trial_ends_at || null,
                suspended_at_before: before.suspended_at || null,
                suspended_at_after: after.suspended_at || null,
                cancelled_at_before: before.cancelled_at || null,
                cancelled_at_after: after.cancelled_at || null,
                request_metadata: requestMetadata
            };

            await AdminAuditDao.record(auditAction, {
                actor_login_id: actor.actorLoginId,
                actor_role: actor.actorRole,
                target_type: 'business',
                target_id: idBusiness,
                target_business_id: idBusiness,
                ip: actor.ip,
                user_agent: actor.userAgent,
                metadata: auditMetadata
            });

            return responseData.success({
                success: true,
                business: mapBusinessCommercial(after)
            }, 'Estado comercial actualizado correctamente');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async extendBusinessTrial(idBusiness, payload = {}, actor = {}) {
        const transaction = await sequelize.transaction();
        let before = null;
        let after = null;

        try {
            if (!idBusiness) {
                await transaction.rollback();
                return responseData.bad_request('Negocio requerido.');
            }

            const days = normalizeRequiredDays(payload.days, MAX_MANUAL_TRIAL_EXTENSION_DAYS);
            if (days === null) {
                await transaction.rollback();
                return responseData.bad_request(`Los dias de extension deben ser un entero entre 1 y ${MAX_MANUAL_TRIAL_EXTENSION_DAYS}.`);
            }

            before = await getBusinessById(idBusiness, transaction, true);
            if (!before) {
                await transaction.rollback();
                return notFound('Negocio no encontrado.');
            }

            if (before.subscription_status !== 'trial') {
                await transaction.rollback();
                return responseData.bad_request('Solo se puede extender el trial de negocios en prueba gratis.');
            }

            const now = new Date();
            const currentEnd = before.trial_ends_at ? new Date(before.trial_ends_at) : null;
            const baseDate = currentEnd && !Number.isNaN(currentEnd.getTime()) && currentEnd > now ? currentEnd : now;
            const nextTrialEndsAt = formatDateTime(addDays(baseDate, days));
            const reason = normalizeReason(payload.reason);

            await sequelize.query(
                `UPDATE business
                    SET trial_ends_at = :_trial_ends_at,
                        status_reason = :_status_reason,
                        updated_at = NOW(),
                        updated_by = :_updated_by
                  WHERE id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}`,
                {
                    replacements: {
                        _id_business: idBusiness,
                        _trial_ends_at: nextTrialEndsAt,
                        _status_reason: reason,
                        _updated_by: actor.actorLoginId || null
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            after = await getBusinessById(idBusiness, transaction, false);
            await transaction.commit();

            await AdminAuditDao.record('SUPER_ADMIN_BUSINESS_TRIAL_EXTEND', {
                actor_login_id: actor.actorLoginId,
                actor_role: actor.actorRole,
                target_type: 'business',
                target_id: idBusiness,
                target_business_id: idBusiness,
                ip: actor.ip,
                user_agent: actor.userAgent,
                metadata: {
                    days,
                    reason,
                    previous_subscription_status: before.subscription_status,
                    new_subscription_status: after.subscription_status,
                    trial_ends_at_before: before.trial_ends_at || null,
                    trial_ends_at_after: after.trial_ends_at || null
                }
            });

            return responseData.success({
                success: true,
                business: mapBusinessCommercial(after)
            }, 'Trial extendido correctamente');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async updateBusinessPlan(idBusiness, payload = {}, actor = {}) {
        const transaction = await sequelize.transaction();
        let before = null;
        let after = null;

        try {
            if (!idBusiness) {
                await transaction.rollback();
                return responseData.bad_request('Negocio requerido.');
            }

            const plan = normalizePlan(payload.plan);
            if (!plan) {
                await transaction.rollback();
                return responseData.bad_request('Plan invalido. Usa basic, pro o enterprise.');
            }

            before = await getBusinessById(idBusiness, transaction, true);
            if (!before) {
                await transaction.rollback();
                return notFound('Negocio no encontrado.');
            }

            const reason = normalizeReason(payload.reason);

            await sequelize.query(
                `UPDATE business
                    SET plan = :_plan,
                        status_reason = :_status_reason,
                        updated_at = NOW(),
                        updated_by = :_updated_by
                  WHERE id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}`,
                {
                    replacements: {
                        _id_business: idBusiness,
                        _plan: plan,
                        _status_reason: reason,
                        _updated_by: actor.actorLoginId || null
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            after = await getBusinessById(idBusiness, transaction, false);
            await transaction.commit();

            await AdminAuditDao.record('SUPER_ADMIN_BUSINESS_PLAN_CHANGE', {
                actor_login_id: actor.actorLoginId,
                actor_role: actor.actorRole,
                target_type: 'business',
                target_id: idBusiness,
                target_business_id: idBusiness,
                ip: actor.ip,
                user_agent: actor.userAgent,
                metadata: {
                    previous_plan: before.plan || null,
                    new_plan: after.plan || null,
                    reason,
                    subscription_status: after.subscription_status || null
                }
            });

            return responseData.success({
                success: true,
                business: mapBusinessCommercial(after)
            }, 'Plan actualizado correctamente');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async closeSession(idSession, actor = {}, payload = {}) {
        // Fail closed until a server-issued step-up proof is implemented.
        if (require('../../config/security').isSuperAdminSessionReauthRequired()) {
            return responseData.forbidden('Se requiere reautenticacion para cerrar sesiones. Esta operacion no esta disponible con la politica actual.', { code: 'SESSION_REAUTH_REQUIRED' });
        }
        const transaction = await sequelize.transaction();
        try {
            if (!idSession) {
                await transaction.rollback();
                return responseData.bad_request('Sesion requerida.');
            }

            const closeOptions = normalizeSessionClosureOptions(payload, 'super_admin_close_session');
            if (closeOptions.error) {
                await transaction.rollback();
                return closeOptions.error;
            }

            const sessions = await sequelize.query(
                `SELECT
                    s.id_session,
                    s.id_login,
                    s.active,
                    s.last,
                    l.id_business
                   FROM \`session\` s
                   INNER JOIN login l
                           ON l.id_login COLLATE utf8mb4_unicode_ci = s.id_login COLLATE utf8mb4_unicode_ci
                  WHERE s.id_session COLLATE utf8mb4_unicode_ci = :_id_session COLLATE utf8mb4_unicode_ci
                  LIMIT 1`,
                {
                    replacements: {
                        _id_session: idSession
                    },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            const session = sessions[0];
            if (!session) {
                await transaction.rollback();
                return responseData.notSuccess('Sesion no encontrada.');
            }

            if (session.id_session === actor.actorSessionId || session.id_login === actor.actorLoginId) {
                await transaction.rollback();
                return forbidden('No puedes cerrar tu propia sesion desde este endpoint.');
            }

            await sequelize.query(
                `UPDATE \`session\`
                    SET active = 0,
                        last = 0,
                        forze_by = :_actor_login_id,
                        forze_at = NOW(),
                        updated_by = :_actor_login_id,
                        updated_at = NOW()
                  WHERE id_session COLLATE utf8mb4_unicode_ci = :_id_session COLLATE utf8mb4_unicode_ci`,
                {
                    replacements: {
                        _actor_login_id: actor.actorLoginId || null,
                        _id_session: idSession
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await sequelize.query(
                `UPDATE refresh_token
                    SET last = 0,
                        revoked_at = COALESCE(revoked_at, NOW()),
                        revoked_reason = COALESCE(revoked_reason, 'super_admin_close_session')
                  WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                    AND id_session COLLATE utf8mb4_unicode_ci = :_id_session COLLATE utf8mb4_unicode_ci
                    AND last = 1`,
                {
                    replacements: {
                        _id_login: session.id_login,
                        _id_session: idSession
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await transaction.commit();

            await AdminAuditDao.record('SUPER_ADMIN_SESSION_CLOSE', {
                actor_login_id: actor.actorLoginId,
                actor_role: actor.actorRole,
                target_type: 'session',
                target_id: idSession,
                target_login_id: session.id_login,
                target_business_id: session.id_business,
                ip: actor.ip,
                user_agent: actor.userAgent,
                metadata: {
                    refresh_invalidation_scope: 'session_bound_refresh_records',
                    reason: closeOptions.reason,
                    confirmation_provided: closeOptions.confirmationProvided,
                    reauth_required_configured: closeOptions.reauthRequiredConfigured
                }
            });

            return responseData.success({
                success: true
            }, 'Sesion cerrada correctamente');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async closeUserSessions(idLogin, actor = {}, payload = {}) {
        const transaction = await sequelize.transaction();
        try {
            if (!idLogin) {
                await transaction.rollback();
                return responseData.bad_request('Usuario requerido.');
            }

            const closeOptions = normalizeSessionClosureOptions(payload, 'super_admin_close_user_sessions');
            if (closeOptions.error) {
                await transaction.rollback();
                return closeOptions.error;
            }

            if (idLogin === actor.actorLoginId) {
                await transaction.rollback();
                return forbidden('No puedes cerrar tus propias sesiones desde este endpoint.');
            }

            const users = await sequelize.query(
                `SELECT id_login, id_business
                   FROM login
                  WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                  LIMIT 1`,
                {
                    replacements: {
                        _id_login: idLogin
                    },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            const user = users[0];
            if (!user) {
                await transaction.rollback();
                return responseData.notSuccess('Usuario no encontrado.');
            }

            const activeSessions = await sequelize.query(
                `SELECT id_session
                   FROM \`session\`
                  WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                    AND active = 1`,
                {
                    replacements: {
                        _id_login: idLogin
                    },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            await sequelize.query(
                `UPDATE \`session\`
                    SET active = 0,
                        last = 0,
                        forze_by = :_actor_login_id,
                        forze_at = NOW(),
                        updated_by = :_actor_login_id,
                        updated_at = NOW()
                  WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                    AND active = 1`,
                {
                    replacements: {
                        _actor_login_id: actor.actorLoginId || null,
                        _id_login: idLogin
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await sequelize.query(
                `UPDATE refresh_token
                    SET last = 0,
                        revoked_at = COALESCE(revoked_at, NOW()),
                        revoked_reason = COALESCE(revoked_reason, 'super_admin_close_user_sessions')
                  WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                    AND last = 1`,
                {
                    replacements: {
                        _id_login: idLogin
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await transaction.commit();

            await AdminAuditDao.record('SUPER_ADMIN_USER_SESSIONS_CLOSE', {
                actor_login_id: actor.actorLoginId,
                actor_role: actor.actorRole,
                target_type: 'login',
                target_id: idLogin,
                target_login_id: idLogin,
                target_business_id: user.id_business,
                ip: actor.ip,
                user_agent: actor.userAgent,
                metadata: {
                    closed_sessions: activeSessions.map((session) => session.id_session),
                    refresh_invalidation_scope: 'user_active_refresh_records',
                    reason: closeOptions.reason,
                    confirmation_provided: closeOptions.confirmationProvided,
                    reauth_required_configured: closeOptions.reauthRequiredConfigured
                }
            });

            return responseData.success({
                success: true,
                closed_sessions: activeSessions.length
            }, 'Sesiones cerradas correctamente');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }
}

module.exports = new SuperAdminDao();

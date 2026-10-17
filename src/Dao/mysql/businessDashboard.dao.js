const effectivePermissions = require('../../util/effectivePermissions');
const { resolveDashboardAccess, PERMISSIONS } = require('../../util/dashboardAccess');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const LicenseUsageDao = require('./licenseUsage.dao');
const {
    DASHBOARD_ACCESS_PERMISSIONS,
    getEffectiveDashboardCapabilities
} = require('../../config/dashboardCapabilities');
const { assertPlanFeature } = require('../../util/planFeatures');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const GRANULARITIES = Object.freeze(['day', 'week', 'month']);
const DEFAULT_GRANULARITY = 'month';
const APPOINTMENT_STATUSES = Object.freeze(['confirmed', 'cancelled', 'pending_confirmation', 'completed', 'rescheduled', 'no_show']);
const PRESCRIPTION_STATUSES = Object.freeze(['draft', 'issued', 'cancelled']);
const CLINICAL_HISTORY_STATUSES = Object.freeze(['DRAFT', 'FINALIZED']);

const collateEq = (left, param) => `${left} COLLATE ${TENANT_COLLATION} = ${param} COLLATE ${TENANT_COLLATION}`;

function isValidDateString(value) {
    if (!DATE_PATTERN.test(String(value || ''))) {
        return false;
    }

    const date = new Date(`${value}T00:00:00`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isoDate(date) {
    return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
}

function startOfWeek(date) {
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    return addDays(date, diff);
}

function defaultRange() {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    return {
        from: isoDate(from),
        to: isoDate(to)
    };
}

function normalizeRange(query = {}) {
    const requestedFrom = query.from || null;
    const requestedTo = query.to || null;
    const fallback = defaultRange();
    const from = requestedFrom || fallback.from;
    const to = requestedTo || fallback.to;

    if (!isValidDateString(from) || !isValidDateString(to)) {
        return {
            error: responseData.bad_request('Rango de fechas invalido.')
        };
    }

    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${to}T00:00:00`);

    if (fromDate.getTime() > toDate.getTime()) {
        return {
            error: responseData.bad_request('Rango de fechas invalido.')
        };
    }

    const rangeDays = Math.floor((toDate.getTime() - fromDate.getTime()) / 86400000) + 1;

    if (rangeDays > MAX_RANGE_DAYS) {
        return {
            error: responseData.bad_request(`El rango maximo permitido es de ${MAX_RANGE_DAYS} dias.`)
        };
    }

    return {
        from,
        to,
        fromDateTime: `${from} 00:00:00`,
        toDateTime: `${to} 23:59:59`,
        rangeDays
    };
}

function normalizeGranularity(value) {
    const granularity = String(value || DEFAULT_GRANULARITY).trim().toLowerCase();

    if (!GRANULARITIES.includes(granularity)) {
        return {
            error: responseData.bad_request('Granularidad invalida. Usa day, week o month.')
        };
    }

    return {
        granularity
    };
}

function buildPreviousRange(range) {
    const currentFromDate = new Date(`${range.from}T00:00:00`);
    const previousToDate = addDays(currentFromDate, -1);
    const previousFromDate = addDays(previousToDate, -(range.rangeDays - 1));

    return {
        from: isoDate(previousFromDate),
        to: isoDate(previousToDate),
        fromDateTime: `${isoDate(previousFromDate)} 00:00:00`,
        toDateTime: `${isoDate(previousToDate)} 23:59:59`,
        rangeDays: range.rangeDays
    };
}

function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function buildPeriods(range, granularity) {
    const periods = [];
    const fromDate = new Date(`${range.from}T00:00:00`);
    const toDate = new Date(`${range.to}T00:00:00`);

    if (granularity === 'day') {
        for (let cursor = fromDate; cursor.getTime() <= toDate.getTime(); cursor = addDays(cursor, 1)) {
            periods.push(isoDate(cursor));
        }
        return periods;
    }

    if (granularity === 'week') {
        for (let cursor = startOfWeek(fromDate); cursor.getTime() <= toDate.getTime(); cursor = addDays(cursor, 7)) {
            periods.push(isoDate(cursor));
        }
        return periods;
    }

    const cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    const end = new Date(toDate.getFullYear(), toDate.getMonth(), 1);

    while (cursor.getTime() <= end.getTime()) {
        periods.push(monthKey(cursor));
        cursor.setMonth(cursor.getMonth() + 1);
    }

    return periods;
}

function periodExpression(dateExpression, granularity) {
    const dateValue = `DATE(${dateExpression})`;

    if (granularity === 'day') {
        return `DATE_FORMAT(${dateValue}, '%Y-%m-%d')`;
    }

    if (granularity === 'week') {
        return `DATE_FORMAT(DATE_SUB(${dateValue}, INTERVAL WEEKDAY(${dateValue}) DAY), '%Y-%m-%d')`;
    }

    return `DATE_FORMAT(${dateValue}, '%Y-%m')`;
}

function countFromRows(rows) {
    const row = rows && rows[0] ? rows[0] : {};
    return Number(row.total || 0);
}

function countByStatus(statuses, rows) {
    const counts = {};
    (rows || []).forEach((row) => {
        counts[String(row.status || '')] = Number(row.total || 0);
    });

    const result = statuses.map((status) => ({
        status,
        count: Number(counts[status] || 0)
    }));

    Object.keys(counts).forEach((status) => {
        if (status && !statuses.includes(status)) {
            result.push({
                status,
                count: counts[status]
            });
        }
    });

    return result;
}

function countStatus(rows, status) {
    const match = (rows || []).find((row) => String(row.status || '') === status);
    return match ? Number(match.count || 0) : 0;
}

function compareMetric(current, previous) {
    const normalizedCurrent = Number(current || 0);
    const normalizedPrevious = Number(previous || 0);
    const delta = normalizedCurrent - normalizedPrevious;

    return {
        current: normalizedCurrent,
        previous: normalizedPrevious,
        delta,
        deltaPercent: normalizedPrevious === 0
            ? (normalizedCurrent === 0 ? 0 : null)
            : Number(((delta / normalizedPrevious) * 100).toFixed(2))
    };
}

function percentage(numerator, denominator) {
    const normalizedNumerator = Number(numerator || 0);
    const normalizedDenominator = Number(denominator || 0);

    if (normalizedDenominator <= 0) {
        return null;
    }

    return Number(((normalizedNumerator / normalizedDenominator) * 100).toFixed(2));
}

function buildBusinessPayload(license) {
    const business = license && license.business ? license.business : {};
    const plan = license && license.plan ? license.plan : {};

    return {
        id_business: business.id_business || null,
        name: business.name || null,
        plan: business.plan || (plan.code || null),
        planName: plan.name || null,
        subscriptionStatus: business.subscription_status || null,
        status: business.status || null,
        active: business.active === undefined ? null : Number(business.active)
    };
}

function buildLicensePayload(license) {
    const limits = license && license.limits ? license.limits : {};
    const auxiliaryUsers = limits.auxiliaryUsers || { used: 0, limit: null, remaining: null, exceeded: false };

    return {
        professionals: limits.professionals || { used: 0, limit: null, remaining: null, exceeded: false },
        staffUsers: limits.staffUsers || auxiliaryUsers,
        auxiliaryUsers
    };
}

function buildLicenseUsagePayload(limitUsage) {
    return {
        used: Number(limitUsage && limitUsage.used ? limitUsage.used : 0),
        limit: limitUsage && limitUsage.limit !== undefined ? limitUsage.limit : null
    };
}

function safeRoleRows(rows) {
    return (rows || [])
        .filter((row) => row.role)
        .map((row) => ({
            role: String(row.role),
            count: Number(row.count || 0)
        }));
}

const unavailable = (reason, fields) => ({ available: false, reason, ...Object.fromEntries(fields.map(key => [key, null])) });
const ownScope = access => access.scope.mode === 'own';
const publicAccess = access => ({ families: access.families, scope: access.scope, canSelectTenant: access.canSelectTenant,
    canSelectOwn: Boolean(access.doctorProfile), administrativeTeam: Boolean(access.administrativeTeam) });
const PRESCRIPTION_ISSUED_AT = "COALESCE(pr.issued_at, CONCAT(pr.issue_date, ' 00:00:00'))";

// An author/capturist is not necessarily the professional responsible for care.
function professionalScope(access, alias, profileField, loginField = null) {
    if (!ownScope(access)) return '';
    const profile = collateEq(`${alias}.${profileField}`, ':_doctor_profile');
    const legacy = loginField ? ` OR (NULLIF(${alias}.${profileField}, '') IS NULL AND ${collateEq(`${alias}.${loginField}`, ':_doctor_login')})` : '';
    return ` AND (${profile}${legacy})`;
}
function replacementsFor(idBusiness, range, access) {
    return { _id_business: idBusiness, _from: range.fromDateTime, _to: range.toDateTime,
        _from_date: range.from, _to_date: range.to, _doctor_profile: access.scope.doctorProfileId || null,
        _doctor_login: access.scope.idLogin || null };
}
function dashboardFor(license, access) {
    const dashboard = getEffectiveDashboardCapabilities(license.plan ? license.plan.code : null);
    const { administrative, clinical, financial } = access.families;
    const team = Boolean(access.administrativeTeam);
    const allowed = { planStatus: team, licenseUsage: team, administrativeAlerts: team, basicActivity: administrative || clinical,
        trends: administrative || clinical, operationalAnalysis: administrative || clinical || financial,
        teamBreakdown: team, professionalBreakdown: clinical, branchBreakdown: false, advancedReports: team };
    Object.keys(dashboard.capabilities).forEach(key => { dashboard.capabilities[key] = Boolean(dashboard.capabilities[key] && allowed[key]); });
    dashboard.access = publicAccess(access);
    return dashboard;
}
function metricDefinitions(access) {
    const own = ownScope(access);
    return {
        patientsCreated: { available: !own, dateBasis: 'person.created_at', reason: own ? 'El expediente es compartido y no tiene propietario médico.' : null },
        appointmentsCreated: { available: true, dateBasis: 'appointment.created_at', attribution: 'doctor_profile_id' },
        appointmentsScheduled: { available: true, dateBasis: 'appointment.appointment_date', attribution: 'doctor_profile_id' },
        prescriptionsIssued: { available: true, dateBasis: 'issued_at (issue_date para registros antiguos)', attribution: 'doctor emisor', excludesCancelled: true },
        clinicalHistoriesFinalized: { available: true, dateBasis: 'finalized_at', attribution: 'doctor responsable' }
    };
}

class BusinessDashboardDao {
    async canAccessTenantDashboard(idLogin) {
        const rows = await effectivePermissions.rows(idLogin);
        const navigation = [...DASHBOARD_ACCESS_PERMISSIONS, PERMISSIONS.administrative, PERMISSIONS.clinical, PERMISSIONS.financial];
        return rows.some(row => navigation.includes(row.code));
    }

    async resolveDashboardContext(idBusiness, featureCode, auditContext = {}, query = {}) {
        const access = await resolveDashboardAccess(idBusiness, auditContext.actorLoginId, { scope: query.scope });
        if (access.error) return access;
        if (featureCode === 'team_usage_metrics' && !access.administrativeTeam) return { error: responseData.forbidden('No tienes permiso para consultar el equipo del consultorio.') };
        if (featureCode === 'professional_activity_metrics' && !access.families.clinical) return { error: responseData.forbidden('No tienes permiso para consultar indicadores clínicos.') };
        if (featureCode === 'trends' && !access.families.administrative && !access.families.clinical) return { error: responseData.forbidden('No tienes permiso para consultar estas tendencias.') };
        const feature = await assertPlanFeature(idBusiness, featureCode, auditContext);
        if (feature.error) return { error: feature.error };
        return { license: feature.license, access, dashboard: dashboardFor(feature.license, access) };
    }

    async summary(idBusiness, query = {}, auditContext = {}) {
        const range = normalizeRange(query);
        if (range.error) return range.error;
        try {
            const context = await this.resolveDashboardContext(idBusiness, 'basic_dashboard', auditContext, query);
            if (context.error) return context.error;
            const { access, license, dashboard } = context;
            const activity = await this.activityTotals(idBusiness, range, access);
            return responseData.success({ range: { from: range.from, to: range.to }, access: publicAccess(access),
                business: access.administrativeTeam ? buildBusinessPayload(license) : { id_business: idBusiness, name: (license.business || {}).name || null },
                ...(access.administrativeTeam ? { license: buildLicensePayload(license) } : {}),
                activity, metricDefinitions: this.allowedDefinitions(access), dashboard, alerts: [] }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) { return SequelizeException(error, Messages.DATA_GET_ERROR); }
    }

    allowedDefinitions(access) {
        const definitions = metricDefinitions(access);
        if (!access.families.administrative) ['patientsCreated', 'appointmentsCreated', 'appointmentsScheduled'].forEach(key => delete definitions[key]);
        if (!access.families.clinical) ['prescriptionsIssued', 'clinicalHistoriesFinalized'].forEach(key => delete definitions[key]);
        return definitions;
    }

    activityQueries(access) {
        const queries = {};
        if (access.families.administrative) {
            queries.patientsCreated = ownScope(access) ? null : `SELECT COUNT(*) AS total FROM person p
                WHERE ${collateEq('p.id_business', ':_id_business')} AND p.created_at >= :_from AND p.created_at <= :_to`;
            queries.appointmentsCreated = `SELECT COUNT(*) AS total FROM appointment a
                WHERE ${collateEq('a.id_business', ':_id_business')} ${professionalScope(access, 'a', 'doctor_profile_id')}
                  AND a.active = 1 AND a.created_at >= :_from AND a.created_at <= :_to`;
        }
        if (access.families.clinical) {
            queries.prescriptionsIssued = `SELECT COUNT(*) AS total FROM prescription pr
                WHERE ${collateEq('pr.id_business', ':_id_business')} ${professionalScope(access, 'pr', 'issuer_doctor_profile_id', 'issuer_doctor_id')}
                  AND pr.active = 1 AND pr.status = 'issued' AND ${PRESCRIPTION_ISSUED_AT} >= :_from AND ${PRESCRIPTION_ISSUED_AT} <= :_to`;
            queries.clinicalHistoriesFinalized = `SELECT COUNT(*) AS total FROM clinical_histories ch
                WHERE ${collateEq('ch.business_id', ':_id_business')} ${professionalScope(access, 'ch', 'doctor_responsible_profile_id', 'doctor_responsible_user_id')}
                  AND ch.status = 'FINALIZED' AND ch.deleted_at IS NULL AND ch.finalized_at >= :_from AND ch.finalized_at <= :_to`;
        }
        return queries;
    }

    async activityTotals(idBusiness, range, access) {
        const replacements = replacementsFor(idBusiness, range, access);
        const entries = await Promise.all(Object.entries(this.activityQueries(access)).map(async ([key, sql]) => [key, sql ? countFromRows(await this.countMetric(sql, replacements)) : null]));
        return Object.fromEntries(entries);
    }

    async trends(idBusiness, query = {}, auditContext = {}) {
        const range = normalizeRange(query), parsed = normalizeGranularity(query.granularity);
        if (range.error || parsed.error) return range.error || parsed.error;
        try {
            const context = await this.resolveDashboardContext(idBusiness, 'trends', auditContext, query);
            if (context.error) return context.error;
            const { access } = context, { granularity } = parsed;
            const periods = buildPeriods(range, granularity), queries = this.activityQueries(access);
            if (access.families.administrative) queries.appointmentsScheduled = `SELECT COUNT(*) AS total FROM appointment a
                WHERE ${collateEq('a.id_business', ':_id_business')} ${professionalScope(access, 'a', 'doctor_profile_id')}
                  AND a.active = 1 AND a.appointment_date >= :_from_date AND a.appointment_date <= :_to_date`;
            const dates = { patientsCreated: 'p.created_at', appointmentsCreated: 'a.created_at', appointmentsScheduled: 'a.appointment_date',
                prescriptionsIssued: PRESCRIPTION_ISSUED_AT, clinicalHistoriesFinalized: 'ch.finalized_at' };
            const series = Object.fromEntries(periods.map(period => [period, { period, ...Object.fromEntries(Object.entries(queries).map(([key, sql]) => [key, sql ? 0 : null])) }]));
            const replacements = replacementsFor(idBusiness, range, access);
            await Promise.all(Object.entries(queries).map(async ([key, sql]) => {
                if (!sql) return;
                const grouped = sql.replace('SELECT COUNT(*) AS total', `SELECT ${periodExpression(dates[key], granularity)} AS period, COUNT(*) AS total`) + ' GROUP BY period ORDER BY period';
                const rows = await this.countMetric(grouped, replacements);
                rows.forEach(row => { if (series[row.period]) series[row.period][key] = Number(row.total || 0); });
            }));
            return responseData.success({ range: { from: range.from, to: range.to }, access: publicAccess(access), metricDefinitions: this.allowedDefinitions(access),
                granularity, weekPeriodFormat: granularity === 'week' ? 'YYYY-MM-DD, lunes de inicio de semana' : null,
                series: periods.map(period => series[period]) }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) { return SequelizeException(error, Messages.DATA_GET_ERROR); }
    }

    async operationalSummary(idBusiness, query = {}, auditContext = {}) {
        const range = normalizeRange(query);
        if (range.error) return range.error;
        try {
            const context = await this.resolveDashboardContext(idBusiness, 'operational_analysis', auditContext, query);
            if (context.error) return context.error;
            const { access } = context, families = access.families, previousRange = buildPreviousRange(range);
            const replacements = replacementsFor(idBusiness, range, access);
            const result = { range: { from: range.from, to: range.to }, previousRange: { from: previousRange.from, to: previousRange.to },
                access: publicAccess(access), periodComparison: {}, decisionMetrics: {}, alerts: [] };
            const [currentActivity, previousActivity] = await Promise.all([this.activityTotals(idBusiness, range, access), this.activityTotals(idBusiness, previousRange, access)]);
            Object.keys(currentActivity).forEach(key => { result.periodComparison[key] = currentActivity[key] === null ? null : compareMetric(currentActivity[key], previousActivity[key]); });
            if (families.administrative) {
                const [rows, retained] = await Promise.all([
                    this.countMetric(`SELECT COALESCE(a.status, 'unknown') AS status, COUNT(*) AS total FROM appointment a
                        WHERE ${collateEq('a.id_business', ':_id_business')} ${professionalScope(access, 'a', 'doctor_profile_id')}
                          AND a.active = 1 AND a.appointment_date >= :_from_date AND a.appointment_date <= :_to_date
                        GROUP BY COALESCE(a.status, 'unknown') ORDER BY status`, replacements),
                    this.firstVisitRetentionSummary(replacements, access)
                ]);
                const byStatus = countByStatus(APPOINTMENT_STATUSES, rows), scheduled = byStatus.reduce((sum, row) => sum + row.count, 0);
                result.appointments = { total: currentActivity.appointmentsCreated, scheduled, byStatus, dateBasis: 'Estado actual de citas programadas en el periodo' };
                const health = { scheduled };
                [['completed', 'completed'], ['cancelled', 'cancelled'], ['noShow', 'no_show'], ['pendingConfirmation', 'pending_confirmation']].forEach(([key, status]) => {
                    health[key] = countStatus(byStatus, status); health[`${key}Rate`] = percentage(health[key], scheduled);
                });
                result.decisionMetrics.appointmentHealth = health;
                const retention = retained[0] || {}, firstVisitPatients = Number(retention.firstVisitPatients || 0), retainedPatients = Number(retention.retainedPatients || 0);
                result.decisionMetrics.retention = { available: true, firstVisitPatients, retainedPatients, retentionRate: percentage(retainedPatients, firstVisitPatients),
                    definition: 'Pacientes cuya primera cita completada ocurrió en el periodo y que completaron otra antes de su cierre; excluye citas futuras.', observationEnd: range.to };
            }
            if (families.clinical) {
                const [prescriptions, histories] = await Promise.all([this.prescriptionStatusSummary(replacements, access), this.clinicalHistoryStatusSummary(replacements, access)]);
                const p = countByStatus(PRESCRIPTION_STATUSES, prescriptions), h = countByStatus(CLINICAL_HISTORY_STATUSES, histories);
                result.prescriptions = { total: p.reduce((sum, row) => sum + row.count, 0), issued: countStatus(p, 'issued'), drafts: countStatus(p, 'draft'), cancelled: countStatus(p, 'cancelled'), byStatus: p,
                    dateBasis: 'Estado actual de recetas creadas en el periodo' };
                result.clinicalHistories = { total: h.reduce((sum, row) => sum + row.count, 0), finalized: countStatus(h, 'FINALIZED'), drafts: countStatus(h, 'DRAFT'), pending: countStatus(h, 'DRAFT'), byStatus: h,
                    dateBasis: 'Estado actual de historias creadas en el periodo' };
                if (ownScope(access)) result.decisionMetrics.followUps = unavailable('Los seguimientos actuales no tienen un doctor responsable atribuible.', ['due', 'scheduled', 'coverageRate']);
                else {
                    const follow = (await this.followUpCoverageSummary(replacements))[0] || {}, due = Number(follow.dueFollowUps || 0), scheduled = Number(follow.scheduledFollowUps || 0);
                    result.decisionMetrics.followUps = { available: true, due, scheduled, coverageRate: percentage(scheduled, due),
                        definition: 'Seguimientos activos con próxima fecha en el periodo y alguna cita vinculada vigente en esa fecha o después.' };
                }
            }
            if (families.financial) {
                const fields = ['patientsWithEstimatedTreatment', 'treatmentItemsWithCost', 'totalEstimatedTreatmentValue', 'averageTreatmentValuePerPatient'];
                if (ownScope(access)) result.decisionMetrics.treatmentEconomics = unavailable('Los tratamientos no tienen un doctor responsable atribuible; no se puede calcular un importe propio.', fields);
                else {
                    const row = (await this.treatmentEconomicsSummary(replacements))[0] || {};
                    result.decisionMetrics.treatmentEconomics = { available: true, ...Object.fromEntries(fields.map(key => [key, Number(row[key] || 0)])),
                        definition: 'Costos estimados de tratamientos creados en el periodo, vigentes y con costo positivo; no representa cobros ni ingresos.', revenueAvailable: false };
                    if (!Number(row.patientsWithEstimatedTreatment || 0)) result.decisionMetrics.treatmentEconomics.averageTreatmentValuePerPatient = null;
                }
            }
            return responseData.success(result, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) { return SequelizeException(error, Messages.DATA_GET_ERROR); }
    }

    async professionalBreakdown(idBusiness, query = {}, auditContext = {}) {
        const range = normalizeRange(query);
        if (range.error) return range.error;
        try {
            const context = await this.resolveDashboardContext(idBusiness, 'professional_activity_metrics', auditContext, query);
            if (context.error) return context.error;
            const rows = await this.professionalActivityRows(replacementsFor(idBusiness, range, context.access), context.access);
            const items = rows.map(row => ({ professionalKey: row.actorKey, label: row.actorKey === 'unassigned' ? 'Sin profesional responsable registrado' : row.professionalName || 'Profesional sin nombre registrado',
                roleLabel: row.actorKey === 'unassigned' ? 'Atribución no disponible' : 'Profesional responsable',
                prescriptionsIssued: Number(row.prescriptionsIssued || 0), clinicalHistoriesFinalized: Number(row.clinicalHistoriesFinalized || 0),
                clinicalHistoriesCreated: null, clinicalHistoriesUpdated: null, documentsSigned: null }));
            return responseData.success({ range: { from: range.from, to: range.to }, access: publicAccess(context.access), displayMode: 'responsibleProfessional', items,
                definition: 'Recetas vigentes emitidas e historias finalizadas, atribuidas al profesional responsable; no mide productividad ni captura del personal.',
                unavailableMetrics: { documentsSigned: 'Métrica no implementada.', clinicalHistoriesCreated: 'La captura no equivale a atención médica.', clinicalHistoriesUpdated: 'La edición no equivale a atención médica.' } }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) { return SequelizeException(error, Messages.DATA_GET_ERROR); }
    }

    async teamBreakdown(idBusiness, query = {}, auditContext = {}) {
        const range = normalizeRange(query);
        if (range.error) return range.error;
        try {
            const context = await this.resolveDashboardContext(idBusiness, 'team_usage_metrics', auditContext, query);
            if (context.error) return context.error;
            const replacements = { _id_business: idBusiness, _professional_roles: LicenseUsageDao.PROFESSIONAL_ROLE_CODES, _ignored_roles: LicenseUsageDao.IGNORED_ROLE_CODES };
            const [rows, roles] = await Promise.all([this.teamUserTotals(replacements), this.teamRoleDistribution(replacements)]);
            const users = rows[0] || {}, limits = context.license.limits || {};
            return responseData.success({ range: { from: range.from, to: range.to }, asOf: new Date().toISOString(), dateBasis: 'Estado actual; no depende del periodo seleccionado', access: publicAccess(context.access),
                users: { active: Number(users.active || 0), inactive: Number(users.inactive || 0), professionals: Number(users.professionals || 0), staffUsers: Number(users.auxiliaryUsers || 0), auxiliaryUsers: Number(users.auxiliaryUsers || 0) },
                roles: safeRoleRows(roles), license: { professionals: buildLicenseUsagePayload(limits.professionals), staffUsers: buildLicenseUsagePayload(limits.staffUsers || limits.auxiliaryUsers), auxiliaryUsers: buildLicenseUsagePayload(limits.auxiliaryUsers) }
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) { return SequelizeException(error, Messages.DATA_GET_ERROR); }
    }

    async countMetric(sql, replacements) { return sequelize.query(sql, { replacements, type: QueryTypes.SELECT }); }

    async prescriptionStatusSummary(replacements, access) {
        return this.countMetric(`SELECT COALESCE(pr.status, 'unknown') AS status, COUNT(*) AS total FROM prescription pr
            WHERE ${collateEq('pr.id_business', ':_id_business')} ${professionalScope(access, 'pr', 'issuer_doctor_profile_id', 'issuer_doctor_id')}
              AND pr.active = 1 AND pr.created_at >= :_from AND pr.created_at <= :_to GROUP BY COALESCE(pr.status, 'unknown') ORDER BY status`, replacements);
    }
    async clinicalHistoryStatusSummary(replacements, access) {
        return this.countMetric(`SELECT COALESCE(ch.status, 'unknown') AS status, COUNT(*) AS total FROM clinical_histories ch
            WHERE ${collateEq('ch.business_id', ':_id_business')} ${professionalScope(access, 'ch', 'doctor_responsible_profile_id', 'doctor_responsible_user_id')}
              AND ch.deleted_at IS NULL AND ch.created_at >= :_from AND ch.created_at <= :_to GROUP BY COALESCE(ch.status, 'unknown') ORDER BY status`, replacements);
    }
    async firstVisitRetentionSummary(replacements, access) {
        return this.countMetric(`SELECT COUNT(*) AS firstVisitPatients, COALESCE(SUM(CASE WHEN EXISTS (
            SELECT 1 FROM appointment later_appointment
             WHERE ${collateEq('later_appointment.id_business', ':_id_business')}
               AND ${collateEq('later_appointment.id_person', 'first_visits.id_person')}
               ${professionalScope(access, 'later_appointment', 'doctor_profile_id')}
               AND later_appointment.active = 1 AND later_appointment.status = 'completed'
               AND TIMESTAMP(later_appointment.appointment_date, later_appointment.start_time) > first_visits.firstAppointmentAt
               AND TIMESTAMP(later_appointment.appointment_date, later_appointment.start_time) <= :_to
               AND TIMESTAMP(later_appointment.appointment_date, later_appointment.start_time) <= NOW()
        ) THEN 1 ELSE 0 END), 0) AS retainedPatients FROM (
            SELECT a.id_person, MIN(TIMESTAMP(a.appointment_date, a.start_time)) AS firstAppointmentAt FROM appointment a
             WHERE ${collateEq('a.id_business', ':_id_business')} ${professionalScope(access, 'a', 'doctor_profile_id')}
               AND a.active = 1 AND a.id_person IS NOT NULL AND a.status = 'completed'
               AND TIMESTAMP(a.appointment_date, a.start_time) <= NOW() GROUP BY a.id_person
        ) first_visits WHERE first_visits.firstAppointmentAt >= :_from AND first_visits.firstAppointmentAt <= :_to`, replacements);
    }
    async followUpCoverageSummary(replacements) {
        return this.countMetric(`SELECT COUNT(DISTINCT t.id_tracing) AS dueFollowUps,
            COUNT(DISTINCT CASE WHEN a.id_appointment IS NOT NULL THEN t.id_tracing END) AS scheduledFollowUps
            FROM tracing t LEFT JOIN appointment a ON ${collateEq('a.id_business', 't.id_business')}
             AND ${collateEq('a.id_tracing', 't.id_tracing')} AND a.active = 1
             AND a.status IN ('pending_confirmation', 'confirmed', 'completed') AND a.appointment_date >= t.quote_date_after
            WHERE ${collateEq('t.id_business', ':_id_business')} AND t.status = 'active'
             AND t.quote_date_after >= :_from_date AND t.quote_date_after <= :_to_date`, replacements);
    }
    async treatmentEconomicsSummary(replacements) {
        return this.countMetric(`SELECT COUNT(*) AS patientsWithEstimatedTreatment,
            COALESCE(SUM(patient_totals.treatmentItemsWithCost), 0) AS treatmentItemsWithCost,
            COALESCE(SUM(patient_totals.estimatedValue), 0) AS totalEstimatedTreatmentValue,
            COALESCE(AVG(patient_totals.estimatedValue), 0) AS averageTreatmentValuePerPatient FROM (
                SELECT pt.id_person, COUNT(*) AS treatmentItemsWithCost, SUM(pt.cost) AS estimatedValue
                FROM patient_treatment pt INNER JOIN treatment_plan tp
                  ON ${collateEq('tp.id_treatment_plan', 'pt.id_treatment_plan')} AND ${collateEq('tp.id_business', 'pt.id_business')}
                WHERE ${collateEq('pt.id_business', ':_id_business')} AND pt.active = 1 AND tp.active = 1
                  AND pt.created_at >= :_from AND pt.created_at <= :_to AND pt.cost > 0 AND pt.status NOT IN ('cancelled', 'deleted')
                GROUP BY pt.id_person
            ) patient_totals`, replacements);
    }
    async professionalActivityRows(replacements, access) {
        // Resolve legacy responsible logins to the same profile key, avoiding two
        // rows for one doctor. Never attribute by created_by/issued_by/event user.
        const actor = (alias, profile, login) => `COALESCE(CONCAT('profile:', NULLIF(${alias}.${profile}, '')), CONCAT('profile:', NULLIF(dpp.id_doctor_professional_profile, '')), CONCAT('login:', NULLIF(${alias}.${login}, ''))) COLLATE ${TENANT_COLLATION}`;
        return this.countMetric(`SELECT COALESCE(activity.actor_key, 'unassigned') AS actorKey, MAX(activity.professional_name) AS professionalName,
            SUM(activity.prescriptionsIssued) AS prescriptionsIssued, SUM(activity.clinicalHistoriesFinalized) AS clinicalHistoriesFinalized
            FROM (
                SELECT ${actor('pr', 'issuer_doctor_profile_id', 'issuer_doctor_id')} AS actor_key,
                    COALESCE(NULLIF(dpp.professional_name, ''), NULLIF(pr.doctor_name_snapshot, '') COLLATE ${TENANT_COLLATION}) COLLATE ${TENANT_COLLATION} AS professional_name,
                    1 AS prescriptionsIssued, 0 AS clinicalHistoriesFinalized FROM prescription pr
                LEFT JOIN doctor_professional_profile dpp ON ${collateEq('dpp.id_business', 'pr.id_business')} AND ${collateEq('dpp.id_login', 'pr.issuer_doctor_id')}
                WHERE ${collateEq('pr.id_business', ':_id_business')} ${professionalScope(access, 'pr', 'issuer_doctor_profile_id', 'issuer_doctor_id')}
                  AND pr.active = 1 AND pr.status = 'issued' AND ${PRESCRIPTION_ISSUED_AT} >= :_from AND ${PRESCRIPTION_ISSUED_AT} <= :_to
                UNION ALL
                SELECT ${actor('ch', 'doctor_responsible_profile_id', 'doctor_responsible_user_id')} AS actor_key,
                    COALESCE(NULLIF(dpp.professional_name, ''), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ch.responsible_snapshot_json, '$.professional_name')), '')) COLLATE ${TENANT_COLLATION} AS professional_name,
                    0 AS prescriptionsIssued, 1 AS clinicalHistoriesFinalized FROM clinical_histories ch
                LEFT JOIN doctor_professional_profile dpp ON ${collateEq('dpp.id_business', 'ch.business_id')} AND ${collateEq('dpp.id_login', 'ch.doctor_responsible_user_id')}
                WHERE ${collateEq('ch.business_id', ':_id_business')} ${professionalScope(access, 'ch', 'doctor_responsible_profile_id', 'doctor_responsible_user_id')}
                  AND ch.status = 'FINALIZED' AND ch.deleted_at IS NULL AND ch.finalized_at >= :_from AND ch.finalized_at <= :_to
            ) activity GROUP BY activity.actor_key
            ORDER BY professionalName, actorKey`, replacements);
    }
    async teamUserTotals(replacements) {
        return this.countMetric(
            `SELECT
                COUNT(DISTINCT CASE
                    WHEN l.active = 1
                     AND LOWER(COALESCE(r.code, '')) NOT IN (:_ignored_roles)
                    THEN l.id_login
                END) AS active,
                COUNT(DISTINCT CASE
                    WHEN COALESCE(l.active, 0) = 0
                     AND LOWER(COALESCE(r.code, '')) NOT IN (:_ignored_roles)
                    THEN l.id_login
                END) AS inactive,
                COUNT(DISTINCT CASE
                    WHEN l.active = 1
                     AND LOWER(COALESCE(r.code, '')) NOT IN (:_ignored_roles)
                     AND (
                        LOWER(COALESCE(r.code, '')) IN (:_professional_roles)
                        OR dpp.id_doctor_professional_profile IS NOT NULL
                     )
                    THEN l.id_login
                END) AS professionals,
                COUNT(DISTINCT CASE
                    WHEN l.active = 1
                     AND LOWER(COALESCE(r.code, '')) NOT IN (:_ignored_roles)
                     AND NOT (
                        LOWER(COALESCE(r.code, '')) IN (:_professional_roles)
                        OR dpp.id_doctor_professional_profile IS NOT NULL
                     )
                    THEN l.id_login
                END) AS auxiliaryUsers
               FROM login l
               LEFT JOIN rol r
                      ON ${collateEq('r.id_rol', 'l.id_rol')}
               LEFT JOIN doctor_professional_profile dpp
                      ON ${collateEq('dpp.id_login', 'l.id_login')}
                     AND ${collateEq('dpp.id_business', 'l.id_business')}
                     AND COALESCE(dpp.is_active, 1) = 1
              WHERE ${collateEq('l.id_business', ':_id_business')}`,
            replacements
        );
    }

    async teamRoleDistribution(replacements) {
        return this.countMetric(
            `SELECT team.role,
                    COUNT(DISTINCT team.id_login) AS count
               FROM (
                    SELECT l.id_login,
                           CASE
                               WHEN LOWER(COALESCE(r.code, '')) IN (:_ignored_roles) THEN NULL
                               WHEN LOWER(COALESCE(r.code, '')) IN (:_professional_roles)
                                    OR dpp.id_doctor_professional_profile IS NOT NULL THEN 'professional'
                               ELSE 'auxiliary'
                           END AS role
                      FROM login l
                      LEFT JOIN rol r
                             ON ${collateEq('r.id_rol', 'l.id_rol')}
                      LEFT JOIN doctor_professional_profile dpp
                             ON ${collateEq('dpp.id_login', 'l.id_login')}
                            AND ${collateEq('dpp.id_business', 'l.id_business')}
                            AND COALESCE(dpp.is_active, 1) = 1
                     WHERE ${collateEq('l.id_business', ':_id_business')}
                       AND l.active = 1
               ) team
              WHERE team.role IS NOT NULL
              GROUP BY team.role
              ORDER BY team.role`,
            replacements
        );
    }

}

module.exports = new BusinessDashboardDao();

const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const { getBusinessEffectiveLicense } = require('../../util/licenseLimits');
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

class BusinessDashboardDao {
    async canAccessTenantDashboard(idLogin) {
        if (!idLogin) {
            return false;
        }

        const rows = await sequelize.query(
            `SELECT cp.code
               FROM login l
              INNER JOIN permission_rol pr
                      ON ${collateEq('pr.id_rol', 'l.id_rol')}
                     AND pr.active = 1
              INNER JOIN cat_permission cp
                      ON ${collateEq('cp.id_cat_permission', 'pr.id_cat_permission')}
                     AND cp.active = 1
              WHERE ${collateEq('l.id_login', ':_id_login')}
                AND cp.code IN (:_permissions)
              LIMIT 1`,
            {
                replacements: {
                    _id_login: idLogin,
                    _permissions: DASHBOARD_ACCESS_PERMISSIONS
                },
                type: QueryTypes.SELECT
            }
        );

        return Boolean(rows && rows.length);
    }

    async resolveDashboardContext(idBusiness, featureCode, auditContext = {}) {
        const featureValidation = await assertPlanFeature(idBusiness, featureCode, auditContext);

        if (featureValidation.error) {
            return {
                error: featureValidation.error
            };
        }

        return {
            license: featureValidation.license,
            dashboard: featureValidation.dashboard
        };
    }

    async summary(idBusiness, query = {}) {
        const range = normalizeRange(query);

        if (range.error) {
            return range.error;
        }

        try {
            const license = await getBusinessEffectiveLicense(idBusiness);

            if (!license) {
                return responseData.bad_request('Negocio invalido para consultar dashboard.');
            }

            const replacements = {
                _id_business: idBusiness,
                _from: range.fromDateTime,
                _to: range.toDateTime
            };

            const [
                patientsCreatedRows,
                appointmentsCreatedRows,
                prescriptionsIssuedRows,
                clinicalHistoriesFinalizedRows
            ] = await Promise.all([
                this.countMetric(
                    `SELECT COUNT(*) AS total
                       FROM person p
                      WHERE ${collateEq('p.id_business', ':_id_business')}
                        AND p.created_at >= :_from
                        AND p.created_at <= :_to`,
                    replacements
                ),
                this.countMetric(
                    `SELECT COUNT(*) AS total
                       FROM appointment a
                      WHERE ${collateEq('a.id_business', ':_id_business')}
                        AND a.created_at >= :_from
                        AND a.created_at <= :_to`,
                    replacements
                ),
                this.countMetric(
                    `SELECT COUNT(*) AS total
                       FROM prescription pr
                      WHERE ${collateEq('pr.id_business', ':_id_business')}
                        AND pr.status = 'issued'
                        AND COALESCE(pr.issued_at, CONCAT(pr.issue_date, ' 00:00:00')) >= :_from
                        AND COALESCE(pr.issued_at, CONCAT(pr.issue_date, ' 00:00:00')) <= :_to`,
                    replacements
                ),
                this.countMetric(
                    `SELECT COUNT(*) AS total
                       FROM clinical_histories ch
                      WHERE ${collateEq('ch.business_id', ':_id_business')}
                        AND ch.status = 'FINALIZED'
                        AND ch.finalized_at >= :_from
                        AND ch.finalized_at <= :_to
                        AND ch.deleted_at IS NULL`,
                    replacements
                )
            ]);

            return responseData.success({
                range: {
                    from: range.from,
                    to: range.to
                },
                business: buildBusinessPayload(license),
                license: buildLicensePayload(license),
                activity: {
                    patientsCreated: countFromRows(patientsCreatedRows),
                    appointmentsCreated: countFromRows(appointmentsCreatedRows),
                    prescriptionsIssued: countFromRows(prescriptionsIssuedRows),
                    clinicalHistoriesFinalized: countFromRows(clinicalHistoriesFinalizedRows)
                },
                dashboard: getEffectiveDashboardCapabilities(license.plan ? license.plan.code : null),
                alerts: []
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async trends(idBusiness, query = {}, auditContext = {}) {
        const range = normalizeRange(query);

        if (range.error) {
            return range.error;
        }

        const granularityResult = normalizeGranularity(query.granularity);

        if (granularityResult.error) {
            return granularityResult.error;
        }

        try {
            const context = await this.resolveDashboardContext(idBusiness, 'trends', auditContext);

            if (context.error) {
                return context.error;
            }

            const { granularity } = granularityResult;
            const periods = buildPeriods(range, granularity);
            const seriesByPeriod = {};

            periods.forEach((period) => {
                seriesByPeriod[period] = {
                    period,
                    patientsCreated: 0,
                    appointmentsCreated: 0,
                    appointmentsScheduled: 0,
                    prescriptionsIssued: 0,
                    clinicalHistoriesFinalized: 0
                };
            });

            const replacements = {
                _id_business: idBusiness,
                _from: range.fromDateTime,
                _to: range.toDateTime,
                _from_date: range.from,
                _to_date: range.to
            };

            const prescriptionIssueDate = "COALESCE(pr.issued_at, CONCAT(pr.issue_date, ' 00:00:00'))";

            const [
                patientsRows,
                appointmentsCreatedRows,
                appointmentsScheduledRows,
                prescriptionsIssuedRows,
                clinicalHistoriesFinalizedRows
            ] = await Promise.all([
                this.aggregateMetricByPeriod(
                    `SELECT ${periodExpression('p.created_at', granularity)} AS period,
                            COUNT(*) AS total
                       FROM person p
                      WHERE ${collateEq('p.id_business', ':_id_business')}
                        AND p.created_at >= :_from
                        AND p.created_at <= :_to
                      GROUP BY period
                      ORDER BY period`,
                    replacements
                ),
                this.aggregateMetricByPeriod(
                    `SELECT ${periodExpression('a.created_at', granularity)} AS period,
                            COUNT(*) AS total
                       FROM appointment a
                      WHERE ${collateEq('a.id_business', ':_id_business')}
                        AND a.created_at >= :_from
                        AND a.created_at <= :_to
                      GROUP BY period
                      ORDER BY period`,
                    replacements
                ),
                this.aggregateMetricByPeriod(
                    `SELECT ${periodExpression('a.appointment_date', granularity)} AS period,
                            COUNT(*) AS total
                       FROM appointment a
                      WHERE ${collateEq('a.id_business', ':_id_business')}
                        AND a.appointment_date >= :_from_date
                        AND a.appointment_date <= :_to_date
                      GROUP BY period
                      ORDER BY period`,
                    replacements
                ),
                this.aggregateMetricByPeriod(
                    `SELECT ${periodExpression(prescriptionIssueDate, granularity)} AS period,
                            COUNT(*) AS total
                       FROM prescription pr
                      WHERE ${collateEq('pr.id_business', ':_id_business')}
                        AND pr.status = 'issued'
                        AND ${prescriptionIssueDate} >= :_from
                        AND ${prescriptionIssueDate} <= :_to
                      GROUP BY period
                      ORDER BY period`,
                    replacements
                ),
                this.aggregateMetricByPeriod(
                    `SELECT ${periodExpression('ch.finalized_at', granularity)} AS period,
                            COUNT(*) AS total
                       FROM clinical_histories ch
                      WHERE ${collateEq('ch.business_id', ':_id_business')}
                        AND ch.status = 'FINALIZED'
                        AND ch.finalized_at >= :_from
                        AND ch.finalized_at <= :_to
                        AND ch.deleted_at IS NULL
                      GROUP BY period
                      ORDER BY period`,
                    replacements
                )
            ]);

            this.applyPeriodRows(seriesByPeriod, patientsRows, 'patientsCreated');
            this.applyPeriodRows(seriesByPeriod, appointmentsCreatedRows, 'appointmentsCreated');
            this.applyPeriodRows(seriesByPeriod, appointmentsScheduledRows, 'appointmentsScheduled');
            this.applyPeriodRows(seriesByPeriod, prescriptionsIssuedRows, 'prescriptionsIssued');
            this.applyPeriodRows(seriesByPeriod, clinicalHistoriesFinalizedRows, 'clinicalHistoriesFinalized');

            return responseData.success({
                range: {
                    from: range.from,
                    to: range.to
                },
                granularity,
                weekPeriodFormat: granularity === 'week' ? 'YYYY-MM-DD, lunes de inicio de semana' : null,
                series: periods.map((period) => seriesByPeriod[period])
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async operationalSummary(idBusiness, query = {}, auditContext = {}) {
        const range = normalizeRange(query);

        if (range.error) {
            return range.error;
        }

        try {
            const context = await this.resolveDashboardContext(idBusiness, 'operational_analysis', auditContext);

            if (context.error) {
                return context.error;
            }

            const previousRange = buildPreviousRange(range);
            const currentReplacements = {
                _id_business: idBusiness,
                _from: range.fromDateTime,
                _to: range.toDateTime,
                _from_date: range.from,
                _to_date: range.to
            };

            const [
                appointmentsTotalRows,
                appointmentsScheduledRows,
                appointmentsStatusRows,
                prescriptionsRows,
                clinicalHistoryRows,
                currentActivity,
                previousActivity
            ] = await Promise.all([
                this.countMetric(
                    `SELECT COUNT(*) AS total
                       FROM appointment a
                      WHERE ${collateEq('a.id_business', ':_id_business')}
                        AND a.created_at >= :_from
                        AND a.created_at <= :_to`,
                    currentReplacements
                ),
                this.countMetric(
                    `SELECT COUNT(*) AS total
                       FROM appointment a
                      WHERE ${collateEq('a.id_business', ':_id_business')}
                        AND a.appointment_date >= :_from_date
                        AND a.appointment_date <= :_to_date`,
                    currentReplacements
                ),
                this.countMetric(
                    `SELECT COALESCE(a.status, 'unknown') AS status,
                            COUNT(*) AS total
                       FROM appointment a
                      WHERE ${collateEq('a.id_business', ':_id_business')}
                        AND a.appointment_date >= :_from_date
                        AND a.appointment_date <= :_to_date
                      GROUP BY COALESCE(a.status, 'unknown')
                      ORDER BY status`,
                    currentReplacements
                ),
                this.prescriptionStatusSummary(currentReplacements),
                this.clinicalHistoryStatusSummary(currentReplacements),
                this.activityTotals(idBusiness, range),
                this.activityTotals(idBusiness, previousRange)
            ]);

            const prescriptionByStatus = countByStatus(PRESCRIPTION_STATUSES, prescriptionsRows);
            const clinicalHistoryByStatus = countByStatus(CLINICAL_HISTORY_STATUSES, clinicalHistoryRows);
            const clinicalDrafts = countStatus(clinicalHistoryByStatus, 'DRAFT');

            return responseData.success({
                range: {
                    from: range.from,
                    to: range.to
                },
                previousRange: {
                    from: previousRange.from,
                    to: previousRange.to
                },
                appointments: {
                    total: countFromRows(appointmentsTotalRows),
                    scheduled: countFromRows(appointmentsScheduledRows),
                    byStatus: countByStatus(APPOINTMENT_STATUSES, appointmentsStatusRows)
                },
                prescriptions: {
                    total: (prescriptionByStatus || []).reduce((acc, item) => acc + Number(item.count || 0), 0),
                    issued: countStatus(prescriptionByStatus, 'issued'),
                    drafts: countStatus(prescriptionByStatus, 'draft'),
                    cancelled: countStatus(prescriptionByStatus, 'cancelled'),
                    byStatus: prescriptionByStatus
                },
                clinicalHistories: {
                    total: (clinicalHistoryByStatus || []).reduce((acc, item) => acc + Number(item.count || 0), 0),
                    finalized: countStatus(clinicalHistoryByStatus, 'FINALIZED'),
                    drafts: clinicalDrafts,
                    pending: (clinicalHistoryByStatus || [])
                        .filter((item) => item.status !== 'FINALIZED')
                        .reduce((acc, item) => acc + Number(item.count || 0), 0),
                    byStatus: clinicalHistoryByStatus
                },
                periodComparison: {
                    patientsCreated: compareMetric(currentActivity.patientsCreated, previousActivity.patientsCreated),
                    appointmentsCreated: compareMetric(currentActivity.appointmentsCreated, previousActivity.appointmentsCreated),
                    prescriptionsIssued: compareMetric(currentActivity.prescriptionsIssued, previousActivity.prescriptionsIssued),
                    clinicalHistoriesFinalized: compareMetric(currentActivity.clinicalHistoriesFinalized, previousActivity.clinicalHistoriesFinalized)
                },
                alerts: []
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async professionalBreakdown(idBusiness, query = {}, auditContext = {}) {
        const range = normalizeRange(query);

        if (range.error) {
            return range.error;
        }

        try {
            const context = await this.resolveDashboardContext(idBusiness, 'professional_activity_metrics', auditContext);

            if (context.error) {
                return context.error;
            }

            const replacements = {
                _id_business: idBusiness,
                _from: range.fromDateTime,
                _to: range.toDateTime
            };

            const rows = await this.professionalActivityRows(replacements);
            const items = (rows || []).map((row, index) => ({
                professionalKey: `professional-${index + 1}`,
                label: `Profesional ${index + 1}`,
                prescriptionsIssued: Number(row.prescriptionsIssued || 0),
                clinicalHistoriesFinalized: Number(row.clinicalHistoriesFinalized || 0),
                documentsSigned: 0
            }));

            return responseData.success({
                range: {
                    from: range.from,
                    to: range.to
                },
                displayMode: 'safeAlias',
                items
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async teamBreakdown(idBusiness, query = {}, auditContext = {}) {
        const range = normalizeRange(query);

        if (range.error) {
            return range.error;
        }

        try {
            const context = await this.resolveDashboardContext(idBusiness, 'team_usage_metrics', auditContext);

            if (context.error) {
                return context.error;
            }

            const replacements = {
                _id_business: idBusiness,
                _professional_roles: LicenseUsageDao.PROFESSIONAL_ROLE_CODES,
                _ignored_roles: LicenseUsageDao.IGNORED_ROLE_CODES
            };

            const [usersRows, rolesRows] = await Promise.all([
                this.teamUserTotals(replacements),
                this.teamRoleDistribution(replacements)
            ]);

            const users = usersRows && usersRows[0] ? usersRows[0] : {};
            const limits = context.license && context.license.limits ? context.license.limits : {};

            return responseData.success({
                range: {
                    from: range.from,
                    to: range.to
                },
                users: {
                    active: Number(users.active || 0),
                    inactive: Number(users.inactive || 0),
                    professionals: Number(users.professionals || 0),
                    staffUsers: Number(users.auxiliaryUsers || 0),
                    auxiliaryUsers: Number(users.auxiliaryUsers || 0)
                },
                roles: safeRoleRows(rolesRows),
                license: {
                    professionals: buildLicenseUsagePayload(limits.professionals),
                    staffUsers: buildLicenseUsagePayload(limits.staffUsers || limits.auxiliaryUsers),
                    auxiliaryUsers: buildLicenseUsagePayload(limits.auxiliaryUsers)
                }
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async countMetric(sql, replacements) {
        return sequelize.query(sql, {
            replacements,
            type: QueryTypes.SELECT
        });
    }

    async professionalActivityRows(replacements) {
        const prescriptionIssueDate = "COALESCE(pr.issued_at, CONCAT(pr.issue_date, ' 00:00:00'))";
        const prescriptionActor = `CASE
            WHEN NULLIF(pr.issuer_doctor_profile_id, '') IS NOT NULL THEN CONCAT('profile:', pr.issuer_doctor_profile_id)
            WHEN NULLIF(pr.issuer_doctor_id, '') IS NOT NULL THEN CONCAT('doctor:', pr.issuer_doctor_id)
            WHEN NULLIF(pr.issued_by, '') IS NOT NULL THEN CONCAT('login:', pr.issued_by)
            WHEN NULLIF(pr.created_by, '') IS NOT NULL THEN CONCAT('login:', pr.created_by)
            ELSE NULL
        END`;
        const clinicalHistoryActor = `CASE
            WHEN NULLIF(ch.doctor_responsible_profile_id, '') IS NOT NULL THEN CONCAT('profile:', ch.doctor_responsible_profile_id)
            WHEN NULLIF(ch.doctor_responsible_user_id, '') IS NOT NULL THEN CONCAT('login:', ch.doctor_responsible_user_id)
            WHEN NULLIF(ch.finalized_by_user_id, '') IS NOT NULL THEN CONCAT('login:', ch.finalized_by_user_id)
            WHEN NULLIF(ch.created_by_user_id, '') IS NOT NULL THEN CONCAT('login:', ch.created_by_user_id)
            ELSE NULL
        END`;

        return this.countMetric(
            `SELECT activity.actor_key AS actorKey,
                    SUM(activity.prescriptionsIssued) AS prescriptionsIssued,
                    SUM(activity.clinicalHistoriesFinalized) AS clinicalHistoriesFinalized,
                    SUM(activity.prescriptionsIssued + activity.clinicalHistoriesFinalized) AS totalActivity
               FROM (
                    SELECT prescriptions.actor_key COLLATE utf8mb4_unicode_ci AS actor_key,
                           COUNT(*) AS prescriptionsIssued,
                           0 AS clinicalHistoriesFinalized
                      FROM (
                            SELECT ${prescriptionActor} AS actor_key
                              FROM prescription pr
                             WHERE ${collateEq('pr.id_business', ':_id_business')}
                               AND pr.status = 'issued'
                               AND ${prescriptionIssueDate} >= :_from
                               AND ${prescriptionIssueDate} <= :_to
                           ) prescriptions
                     WHERE prescriptions.actor_key IS NOT NULL
                     GROUP BY prescriptions.actor_key COLLATE utf8mb4_unicode_ci
                    UNION ALL
                    SELECT clinical.actor_key COLLATE utf8mb4_unicode_ci AS actor_key,
                           0 AS prescriptionsIssued,
                           COUNT(*) AS clinicalHistoriesFinalized
                      FROM (
                            SELECT ${clinicalHistoryActor} AS actor_key
                              FROM clinical_histories ch
                             WHERE ${collateEq('ch.business_id', ':_id_business')}
                               AND ch.status = 'FINALIZED'
                               AND ch.finalized_at >= :_from
                               AND ch.finalized_at <= :_to
                               AND ch.deleted_at IS NULL
                           ) clinical
                     WHERE clinical.actor_key IS NOT NULL
                     GROUP BY clinical.actor_key COLLATE utf8mb4_unicode_ci
               ) activity
              GROUP BY activity.actor_key
              ORDER BY totalActivity DESC, activity.actor_key`,
            replacements
        );
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

    async aggregateMetricByPeriod(sql, replacements) {
        return this.countMetric(sql, replacements);
    }

    applyPeriodRows(seriesByPeriod, rows, metricKey) {
        (rows || []).forEach((row) => {
            const period = String(row.period || '');

            if (seriesByPeriod[period]) {
                seriesByPeriod[period][metricKey] = Number(row.total || 0);
            }
        });
    }

    async prescriptionStatusSummary(replacements) {
        return this.countMetric(
            `SELECT COALESCE(pr.status, 'unknown') AS status,
                    COUNT(*) AS total
               FROM prescription pr
              WHERE ${collateEq('pr.id_business', ':_id_business')}
                AND pr.created_at >= :_from
                AND pr.created_at <= :_to
              GROUP BY COALESCE(pr.status, 'unknown')
              ORDER BY status`,
            replacements
        );
    }

    async clinicalHistoryStatusSummary(replacements) {
        return this.countMetric(
            `SELECT COALESCE(ch.status, 'unknown') AS status,
                    COUNT(*) AS total
               FROM clinical_histories ch
              WHERE ${collateEq('ch.business_id', ':_id_business')}
                AND ch.created_at >= :_from
                AND ch.created_at <= :_to
                AND ch.deleted_at IS NULL
              GROUP BY COALESCE(ch.status, 'unknown')
              ORDER BY status`,
            replacements
        );
    }

    async activityTotals(idBusiness, range) {
        const replacements = {
            _id_business: idBusiness,
            _from: range.fromDateTime,
            _to: range.toDateTime
        };
        const prescriptionIssueDate = "COALESCE(pr.issued_at, CONCAT(pr.issue_date, ' 00:00:00'))";

        const [
            patientsCreatedRows,
            appointmentsCreatedRows,
            prescriptionsIssuedRows,
            clinicalHistoriesFinalizedRows
        ] = await Promise.all([
            this.countMetric(
                `SELECT COUNT(*) AS total
                   FROM person p
                  WHERE ${collateEq('p.id_business', ':_id_business')}
                    AND p.created_at >= :_from
                    AND p.created_at <= :_to`,
                replacements
            ),
            this.countMetric(
                `SELECT COUNT(*) AS total
                   FROM appointment a
                  WHERE ${collateEq('a.id_business', ':_id_business')}
                    AND a.created_at >= :_from
                    AND a.created_at <= :_to`,
                replacements
            ),
            this.countMetric(
                `SELECT COUNT(*) AS total
                   FROM prescription pr
                  WHERE ${collateEq('pr.id_business', ':_id_business')}
                    AND pr.status = 'issued'
                    AND ${prescriptionIssueDate} >= :_from
                    AND ${prescriptionIssueDate} <= :_to`,
                replacements
            ),
            this.countMetric(
                `SELECT COUNT(*) AS total
                   FROM clinical_histories ch
                  WHERE ${collateEq('ch.business_id', ':_id_business')}
                    AND ch.status = 'FINALIZED'
                    AND ch.finalized_at >= :_from
                    AND ch.finalized_at <= :_to
                    AND ch.deleted_at IS NULL`,
                replacements
            )
        ]);

        return {
            patientsCreated: countFromRows(patientsCreatedRows),
            appointmentsCreated: countFromRows(appointmentsCreatedRows),
            prescriptionsIssued: countFromRows(prescriptionsIssuedRows),
            clinicalHistoriesFinalized: countFromRows(clinicalHistoriesFinalizedRows)
        };
    }
}

module.exports = new BusinessDashboardDao();

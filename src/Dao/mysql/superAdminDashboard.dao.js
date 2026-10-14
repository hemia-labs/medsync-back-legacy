const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');

const COLLATION = 'utf8mb4_unicode_ci';
const USAGE_SOURCES = [
    { table: 'person', businessColumn: 'id_business', metric: 'patients', series: 'patientSeries' },
    { table: 'appointment', businessColumn: 'id_business', metric: 'appointments', series: 'appointmentSeries' },
    { table: 'prescription', businessColumn: 'id_business', metric: 'prescriptions', series: 'prescriptionSeries' },
    { table: 'clinical_histories', businessColumn: 'business_id', metric: 'clinicalHistories', series: 'clinicalHistorySeries', where: 'deleted_at IS NULL' }
];

function scope(column, replacements) {
    return replacements._dashboard_business_id
        ? `${column} COLLATE ${COLLATION} = :_dashboard_business_id COLLATE ${COLLATION}`
        : '1 = 1';
}

function inRange(column) {
    return `${column} >= :_dashboard_from AND ${column} <= :_dashboard_to`;
}

function countWhen(condition, alias) {
    return `COALESCE(SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0) AS ${alias}`;
}

async function select(sql, replacements) {
    return sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
}

function numbers(row = {}) {
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)]));
}

async function getBusinessMetrics(replacements) {
    const conditions = {
        activeBusinesses: 'b.active = 1',
        inactiveBusinesses: 'b.active = 0',
        suspendedBusinesses: "LOWER(COALESCE(b.status, '')) = 'suspended'",
        trialBusinesses: "b.subscription_status = 'trial'",
        activeSubscriptionBusinesses: "b.subscription_status = 'active'",
        pastDueBusinesses: "b.subscription_status = 'past_due'",
        suspendedSubscriptionBusinesses: "b.subscription_status = 'suspended'",
        cancelledBusinesses: "b.subscription_status = 'cancelled'",
        expiredTrials: "b.subscription_status = 'trial' AND b.trial_ends_at < NOW()",
        trialsExpiringSoon: "b.subscription_status = 'trial' AND b.trial_ends_at >= NOW() AND b.trial_ends_at <= DATE_ADD(NOW(), INTERVAL 7 DAY)",
        newBusinesses: inRange('b.created_at'),
        newTrialBusinesses: `b.subscription_status = 'trial' AND ${inRange('b.created_at')}`,
        newActiveSubscriptionBusinesses: `b.subscription_status = 'active' AND ${inRange('b.created_at')}`,
        businessesWithoutAdmin: 'admins.id_business IS NULL',
        businessesWithoutActivityLast30Days: 'b.active = 1 AND recent_sessions.id_business IS NULL'
    };
    const rows = await select(
        `SELECT COUNT(*) AS businesses,
                ${Object.entries(conditions).map(([alias, condition]) => countWhen(condition, alias)).join(',\n                ')}
           FROM business b
           LEFT JOIN (
                SELECT al.id_business COLLATE ${COLLATION} AS id_business
                  FROM login al
                  INNER JOIN rol ar ON ar.id_rol COLLATE ${COLLATION} = al.id_rol COLLATE ${COLLATION}
                 WHERE al.active = 1 AND ar.code IN ('admin', 'business_admin')
                   AND ${scope('al.id_business', replacements)}
                 GROUP BY al.id_business COLLATE ${COLLATION}
           ) admins ON admins.id_business = b.id_business COLLATE ${COLLATION}
           LEFT JOIN (
                SELECT ul.id_business COLLATE ${COLLATION} AS id_business
                  FROM login ul
                  INNER JOIN \`session\` us ON us.id_login COLLATE ${COLLATION} = ul.id_login COLLATE ${COLLATION}
                 WHERE COALESCE(us.updated_at, us.created_at) >= :_dashboard_from
                   AND ${scope('ul.id_business', replacements)}
                 GROUP BY ul.id_business COLLATE ${COLLATION}
           ) recent_sessions ON recent_sessions.id_business = b.id_business COLLATE ${COLLATION}
          WHERE ${scope('b.id_business', replacements)}`,
        replacements
    );
    return numbers(rows[0]);
}

async function getUserMetrics(replacements) {
    const rows = await select(
        `SELECT COUNT(*) AS users,
                ${countWhen('l.active = 1', 'activeUsers')},
                ${countWhen('l.locked = 1', 'lockedUsers')},
                ${countWhen(inRange('l.created_at'), 'newUsers')}
           FROM login l
          WHERE ${scope('l.id_business', replacements)}`,
        replacements
    );
    return numbers(rows[0]);
}

async function getTopBusinesses(replacements) {
    // Each derived table returns at most one row per tenant. Joining raw clinical
    // tables here multiplies users x patients x appointments x documents x activity.
    const usageJoins = USAGE_SOURCES.map((source) => `LEFT JOIN (
            SELECT ${source.businessColumn} COLLATE ${COLLATION} AS id_business, COUNT(*) AS total
              FROM ${source.table}
             WHERE ${inRange('created_at')}
               AND ${scope(source.businessColumn, replacements)}
               ${source.where ? `AND ${source.where}` : ''}
             GROUP BY ${source.businessColumn} COLLATE ${COLLATION}
        ) ${source.metric} ON ${source.metric}.id_business = b.id_business COLLATE ${COLLATION}`);
    const activitySources = [
        `SELECT ul.id_business COLLATE ${COLLATION} AS id_business,
                MAX(COALESCE(us.updated_at, us.created_at)) AS activity_at
           FROM login ul
           INNER JOIN \`session\` us ON us.id_login COLLATE ${COLLATION} = ul.id_login COLLATE ${COLLATION}
          WHERE ${scope('ul.id_business', replacements)}
          GROUP BY ul.id_business COLLATE ${COLLATION}`,
        ...USAGE_SOURCES.map((source) => `SELECT ${source.businessColumn} COLLATE ${COLLATION} AS id_business,
                MAX(created_at) AS activity_at
           FROM ${source.table}
          WHERE ${scope(source.businessColumn, replacements)} ${source.where ? `AND ${source.where}` : ''}
          GROUP BY ${source.businessColumn} COLLATE ${COLLATION}`)
    ];
    return select(
        `SELECT b.id_business, b.name, b.subscription_status, b.plan, b.trial_ends_at,
                COALESCE(users.total, 0) AS users,
                ${USAGE_SOURCES.map((source) => `COALESCE(${source.metric}.total, 0) AS ${source.metric}`).join(',\n                ')},
                activity.activity_at AS lastActivityAt
           FROM business b
           LEFT JOIN (
                SELECT id_business COLLATE ${COLLATION} AS id_business, COUNT(*) AS total
                  FROM login
                 WHERE ${scope('id_business', replacements)}
                 GROUP BY id_business COLLATE ${COLLATION}
           ) users ON users.id_business = b.id_business COLLATE ${COLLATION}
           ${usageJoins.join('\n           ')}
           LEFT JOIN (
                SELECT id_business, MAX(activity_at) AS activity_at
                  FROM (${activitySources.join('\n                UNION ALL\n                ')}) source_activity
                 GROUP BY id_business
           ) activity ON activity.id_business = b.id_business COLLATE ${COLLATION}
          WHERE ${scope('b.id_business', replacements)}
          ORDER BY (patients + appointments + prescriptions + clinicalHistories + users) DESC, b.created_at DESC
          LIMIT 10`,
        replacements
    );
}

async function getDashboardMetrics(replacements, monthlyMetric) {
    // Execute sequentially: one dashboard must not monopolize the shared pool.
    const metrics = await getBusinessMetrics(replacements);
    Object.assign(metrics, await getUserMetrics(replacements));
    const sessions = await select(
        `SELECT COUNT(*) AS activeSessions
           FROM \`session\` s
           INNER JOIN login sl ON sl.id_login COLLATE ${COLLATION} = s.id_login COLLATE ${COLLATION}
          WHERE s.active = 1 AND s.last = 1 AND ${scope('sl.id_business', replacements)}`,
        replacements
    );
    Object.assign(metrics, numbers(sessions[0]));
    metrics.businessSeries = await monthlyMetric('business b', 'b.created_at', 'b.id_business', replacements);
    metrics.userSeries = await monthlyMetric('login l', 'l.created_at', 'l.id_business', replacements);
    for (const source of USAGE_SOURCES) {
        const series = await monthlyMetric(source.table, 'created_at', source.businessColumn, replacements, source.where || '');
        metrics[source.series] = series;
        metrics[`${source.metric}Created`] = series.reduce((total, row) => total + row.total, 0);
    }
    metrics.topBusinessesByUsage = await getTopBusinesses(replacements);
    return metrics;
}

module.exports = { getDashboardMetrics };

'use strict';

// Uses one MySQL connection and connection-local TEMPORARY tables only.
// No application records, sessions, tenants or persistent schema are changed.
process.env.SQL_LOGGING = 'false';
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { Utils } = require('sequelize');
const config = require('../../src/config/config');
const sequelize = require('../../src/db/Sequelize.connection');
const dao = require('../../src/Dao/mysql/superAdmin.dao');
const routes = require('../../src/routes/mysql/super-admin');

const schemas = {
    business: 'id_business VARCHAR(50), name VARCHAR(100), legal_name VARCHAR(100), slug VARCHAR(100), email VARCHAR(100), phone VARCHAR(50), active INT, status VARCHAR(30), subscription_status VARCHAR(30), plan VARCHAR(30), trial_ends_at DATETIME, created_at DATETIME',
    login: 'id_login VARCHAR(50), id_business VARCHAR(50), id_rol VARCHAR(50), active INT, locked INT, created_at DATETIME',
    rol: 'id_rol VARCHAR(50), code VARCHAR(30)',
    session: 'id_login VARCHAR(50), active INT, last INT, created_at DATETIME, updated_at DATETIME',
    person: 'id_person VARCHAR(50), id_business VARCHAR(50), created_at DATETIME',
    appointment: 'id_appointment VARCHAR(50), id_business VARCHAR(50), created_at DATETIME',
    prescription: 'id_prescription VARCHAR(50), id_business VARCHAR(50), created_at DATETIME',
    clinical_histories: 'id_clinical_history VARCHAR(50), business_id VARCHAR(50), created_at DATETIME, deleted_at DATETIME'
};
const clinicalSources = [
    ['person', 'id_business', 'patients', 'patientsCreated'],
    ['appointment', 'id_business', 'appointments', 'appointmentsCreated'],
    ['prescription', 'id_business', 'prescriptions', 'prescriptionsCreated'],
    ['clinical_histories', 'business_id', 'clinicalHistories', 'clinicalHistoriesCreated']
];

function fixtures() {
    const rows = Object.fromEntries(Object.keys(schemas).map(table => [table, []]));
    rows.rol = [{ id_rol: 'ADMIN', code: 'admin' }, { id_rol: 'DOCTOR', code: 'doctor' }];
    const states = ['active', 'trial', 'past_due', 'suspended', 'cancelled', null];
    for (let index = 0; index < 12; index += 1) {
        const id = `FIXTURE_${String(index).padStart(2, '0')}`;
        rows.business.push({ id_business: id, name: id, active: index % 4 === 0 ? 0 : 1,
            status: index % 3 === 0 ? 'SUSPENDED' : 'active', subscription_status: states[index % states.length],
            plan: 'pro', trial_ends_at: index === 1 ? '2000-01-01 00:00:00' : null,
            created_at: `2026-06-${String(index + 1).padStart(2, '0')} 12:00:00` });
        rows.login.push({ id_login: `${id}_ADMIN`, id_business: id, id_rol: 'ADMIN', active: index % 2,
            locked: index % 3 === 0 ? 1 : 0, created_at: '2026-06-01 00:00:00' });
        rows.login.push({ id_login: `${id}_DOCTOR`, id_business: id, id_rol: 'DOCTOR', active: 1,
            locked: 0, created_at: '2026-05-31 23:59:59' });
        rows.session.push({ id_login: `${id}_ADMIN`, active: 1, last: index % 2,
            created_at: '2026-05-15 00:00:00', updated_at: index % 2 ? '2026-06-15 00:00:00' : null });
        // Last activity intentionally includes dates outside the selected period.
        rows.session.push({ id_login: `${id}_DOCTOR`, active: 0, last: 0,
            created_at: '2026-07-15 00:00:00', updated_at: null });
        for (const [table, businessColumn] of clinicalSources) {
            const idColumn = table === 'clinical_histories' ? 'id_clinical_history' : `id_${table}`;
            for (let number = 0; number < index % 4; number += 1) {
                const row = { [idColumn]: `${id}_${table}_${number}`, [businessColumn]: id,
                    created_at: number === 0 ? '2026-06-30 23:59:59' : '2026-06-15 12:00:00' };
                if (table === 'clinical_histories') row.deleted_at = number === 2 ? '2026-07-01 00:00:00' : null;
                rows[table].push(row);
            }
        }
    }
    rows.login.push({ id_login: 'GLOBAL_USER', id_business: null, id_rol: 'ADMIN', active: 1, locked: 1, created_at: '2026-06-15 00:00:00' });
    rows.session.push({ id_login: 'ORPHAN', active: 1, last: 1, created_at: '2026-06-15 00:00:00', updated_at: null });
    rows.person.push({ id_person: 'GLOBAL_PATIENT', id_business: null, created_at: '2026-06-15 00:00:00' });
    return rows;
}

function expected(rows, query) {
    const range = value => value && value >= `${query.from} 00:00:00` && value <= `${query.to} 23:59:59`;
    const scoped = (row, column) => !query.businessId || row[column] === query.businessId;
    const businesses = rows.business.filter(row => scoped(row, 'id_business'));
    const users = rows.login.filter(row => scoped(row, 'id_business'));
    const count = (items, condition) => items.filter(condition).length;
    const states = {
        trialBusinesses: 'trial', activeSubscriptionBusinesses: 'active', pastDueBusinesses: 'past_due',
        suspendedSubscriptionBusinesses: 'suspended', cancelledBusinesses: 'cancelled'
    };
    const totals = {
        businesses: businesses.length,
        activeBusinesses: count(businesses, row => row.active === 1),
        inactiveBusinesses: count(businesses, row => row.active === 0),
        suspendedBusinesses: count(businesses, row => row.status.toLowerCase() === 'suspended'),
        expiredTrials: count(businesses, row => row.subscription_status === 'trial' && row.trial_ends_at && new Date(row.trial_ends_at) < new Date()),
        trialsExpiringSoon: 0,
        users: users.length, activeUsers: count(users, row => row.active === 1), lockedUsers: count(users, row => row.locked === 1),
        activeSessions: count(rows.session, row => row.active === 1 && row.last === 1 && users.some(user => user.id_login === row.id_login))
    };
    for (const [key, state] of Object.entries(states)) totals[key] = count(businesses, row => row.subscription_status === state);
    const withoutAdmin = count(businesses, business => !users.some(user => user.id_business === business.id_business && user.active === 1 && user.id_rol === 'ADMIN'));
    const withoutActivity = count(businesses, business => business.active === 1 && !rows.session.some(session => {
        const user = users.find(item => item.id_login === session.id_login);
        return user && user.id_business === business.id_business && (session.updated_at || session.created_at) >= `${query.from} 00:00:00`;
    }));
    const clinicalUsage = {};
    const monthlySeries = {};
    const series = (items, column) => {
        const counts = {};
        items.filter(row => scoped(row, column) && range(row.created_at)).forEach(row => {
            const month = row.created_at.slice(0, 7);
            counts[month] = (counts[month] || 0) + 1;
        });
        return Object.keys(counts).sort().map(month => ({ month, total: counts[month] }));
    };
    monthlySeries.businesses = series(rows.business, 'id_business');
    monthlySeries.users = series(rows.login, 'id_business');
    for (const [table, column, metric, total] of clinicalSources) {
        const source = rows[table].filter(row => !row.deleted_at);
        clinicalUsage[total] = count(source, row => scoped(row, column) && range(row.created_at));
        monthlySeries[metric] = series(source, column);
    }
    const top = businesses.map(business => {
        const tenantUsers = users.filter(user => user.id_business === business.id_business);
        const item = { id_business: business.id_business, users: tenantUsers.length, lastActivityAt: null };
        const activity = rows.session.filter(session => tenantUsers.some(user => user.id_login === session.id_login))
            .map(session => session.updated_at || session.created_at);
        for (const [table, column, metric] of clinicalSources) {
            const source = rows[table].filter(row => row[column] === business.id_business && !row.deleted_at);
            item[metric] = count(source, row => range(row.created_at));
            activity.push(...source.map(row => row.created_at));
        }
        item.lastActivityAt = activity.filter(Boolean).sort().pop() || null;
        return { ...item, createdAt: business.created_at, score: item.users + item.patients + item.appointments + item.prescriptions + item.clinicalHistories };
    }).sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt)).slice(0, 10)
        .map(({ createdAt, score, ...item }) => item);
    return { totals, clinicalUsage, monthlySeries, top, withoutAdmin, withoutActivity,
        recent: { newBusinesses: count(businesses, row => range(row.created_at)),
            newTrialBusinesses: count(businesses, row => row.subscription_status === 'trial' && range(row.created_at)),
            newActiveSubscriptionBusinesses: count(businesses, row => row.subscription_status === 'active' && range(row.created_at)),
            convertedToActive: 0, newUsers: count(users, row => range(row.created_at)), businessesWithoutRecentActivity: withoutActivity } };
}

async function main() {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL,
        user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, dateStrings: true });
    const originalQuery = sequelize.query;
    const rows = fixtures();
    let queries = 0;
    let pending = 0;
    let maxPending = 0;
    try {
        // MySQL cannot reopen one temporary table twice in a statement. Separate
        // copies allow testing the real SQL with multiple independent aggregates.
        for (const [table, schema] of Object.entries(schemas)) {
            for (let copy = 1; copy <= 3; copy += 1) {
                const name = `qa_sa_${table}_${copy}`;
                await connection.query(`CREATE TEMPORARY TABLE ${name} (${schema}) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
                if (rows[table].length) {
                    const columns = Object.keys(rows[table][0]);
                    const values = rows[table].map(row => columns.map(column => row[column]));
                    await connection.query(`INSERT INTO ${name} (${columns.join(', ')}) VALUES ?`, [values]);
                }
            }
        }
        sequelize.query = async (sql, options) => {
            queries += 1;
            pending += 1;
            maxPending = Math.max(maxPending, pending);
            try {
                const references = {};
                const rewritten = sql.replace(/\b(FROM|JOIN)\s+`?(business|login|rol|session|person|appointment|prescription|clinical_histories)`?(?=\s|$)/gi,
                    (_, keyword, table) => {
                        table = table.toLowerCase();
                        references[table] = (references[table] || 0) + 1;
                        assert.ok(references[table] <= 3);
                        return `${keyword} qa_sa_${table}_${references[table]}`;
                    });
                const [result] = await connection.query(Utils.formatNamedParameters(rewritten, options.replacements || {}, 'mysql'));
                return result;
            } finally { pending -= 1; }
        };
        const cases = [
            { from: '2026-06-01', to: '2026-06-30' },
            { from: '2026-06-01', to: '2026-06-30', businessId: 'FIXTURE_03' },
            { from: '2026-06-01', to: '2026-06-30', businessId: 'MISSING' },
            { from: '2026-06-30', to: '2026-06-30' },
            { from: '2026-04-01', to: '2026-04-30' }
        ];
        for (const query of cases) {
            queries = 0;
            maxPending = 0;
            const response = await dao.dashboardSummary(query);
            assert.equal(response.status, 200, response.message);
            assert.equal(queries, 10, 'Dashboard query budget');
            assert.equal(maxPending, 1, 'Dashboard must not fan out across the pool');
            const oracle = expected(rows, query);
            assert.deepEqual(response.data.totals, oracle.totals);
            assert.deepEqual(response.data.recent, oracle.recent);
            assert.deepEqual(response.data.clinicalUsage, oracle.clinicalUsage);
            assert.deepEqual(response.data.monthlySeries, oracle.monthlySeries);
            assert.equal(response.data.alerts.businessesWithoutAdmin, oracle.withoutAdmin);
            assert.equal(response.data.alerts.businessesWithoutActivityLast30Days, oracle.withoutActivity);
            assert.deepEqual(response.data.topBusinessesByUsage.map(item => ({ id_business: item.id_business,
                users: item.users, patients: item.patients, appointments: item.appointments,
                prescriptions: item.prescriptions, clinicalHistories: item.clinicalHistories,
                lastActivityAt: item.lastActivityAt })), oracle.top);
            console.log(`PASS dashboard ${JSON.stringify(query)}: 10 queries, max concurrency 1`);
        }
        for (const query of [{ from: 'invalid' }, { from: '2026-06-30', to: '2026-06-01' }]) {
            queries = 0;
            assert.equal((await dao.dashboardSummary(query)).status, 400);
            assert.equal(queries, 0);
        }
        queries = 0;
        const options = await dao.businessOptions({ page: 2, pageSize: 3, search: 'FIXTURE_' });
        assert.equal(options.status, 200, options.message);
        assert.equal(queries, 1);
        assert.deepEqual(options.data.data, rows.business.slice(3, 6).map(row => ({ id_business: row.id_business, name: row.name })));
        console.log('PASS invalid ranges and paginated business options (one query, id/name only)');
        for (const path of ['/dashboard/summary', '/business-options']) {
            const route = routes.stack.find(layer => layer.route && layer.route.path === path).route;
            assert.equal(route.stack.length, 3, 'Auth, role and controller remain required');
            for (const role of ['doctor', 'admin', 'super_admin']) {
                let status;
                let continued = false;
                const response = { status(value) { status = value; return this; }, send() {} };
                route.stack[1].handle({ tokenDecode: { rol: role } }, response, () => { continued = true; });
                assert.equal(continued, role === 'super_admin');
                if (role !== 'super_admin') assert.equal(status, 403);
            }
        }
        console.log('PASS both routes deny tenant roles with 403 and accept super_admin');
    } finally {
        sequelize.query = originalQuery;
        await connection.end();
        await sequelize.close();
    }
}

main().catch(error => {
    console.error(error instanceof assert.AssertionError ? error.message : `Regression failed: ${error.code || error.name}`);
    process.exitCode = 1;
});

'use strict';

// One MySQL connection; writes are restricted to connection-local temporary
// copies of the installed schema. Permission seed helpers are test doubles.
process.env.SQL_LOGGING = 'false';
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { Utils } = require('sequelize');
const config = require('../../src/config/config');
const sequelize = require('../../src/db/Sequelize.connection');
const { compare } = require('../../src/util/bcrypt');
const dashboard = require('../../src/util/dashboardAccess');
const tracing = require('../../src/util/tracingPermissions');
const tables = ['business', 'login', 'rol', 'appointment_config', 'cat_ui_theme', 'ui_theme_configuration', 'admin_audit_log'];

async function main() {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL,
        user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    const original = { query: sequelize.query, transaction: sequelize.transaction,
        dashboard: dashboard.seedDashboardPermissions, tracing: tracing.seedTracingPermissions };
    let transaction;
    let commits = 0;
    let rollbacks = 0;
    let seedCalls = 0;
    let failLoginInsert = false;
    const password = randomBytes(24).toString('hex');
    try {
        for (const table of tables) {
            await connection.query(`CREATE TEMPORARY TABLE qa_create_${table} LIKE ${table}`);
        }
        // Only non-sensitive catalog rows are read; no live business/login data.
        await connection.query("INSERT INTO qa_create_rol SELECT * FROM rol WHERE code IN ('admin', 'business_admin') AND active = 1");
        await connection.query("INSERT INTO qa_create_cat_ui_theme SELECT * FROM cat_ui_theme WHERE code = 'medical-blue' AND active = 1 LIMIT 1");
        await connection.query("INSERT INTO qa_create_login (id_login, telephone, email, active) VALUES ('existing', '0001112233', 'existing@example.test', 1)");

        sequelize.transaction = async () => {
            await connection.beginTransaction();
            transaction = {
                async commit() { await connection.commit(); commits += 1; },
                async rollback() { await connection.rollback(); rollbacks += 1; }
            };
            return transaction;
        };
        sequelize.query = async (sql, options = {}) => {
            const rewritten = sql.replace(/\b(FROM|JOIN|INTO|UPDATE)\s+`?(\w+)`?/gi, (_, keyword, table) => {
                assert.ok(tables.includes(table), `Unexpected SQL table: ${table}`);
                return `${keyword} qa_create_${table}`;
            });
            if (failLoginInsert && /INSERT INTO qa_create_login/.test(rewritten)) throw new Error('Synthetic login insert failure');
            if (!/INTO qa_create_admin_audit_log/.test(rewritten)) assert.equal(options.transaction, transaction);
            const [result] = await connection.query(Utils.formatNamedParameters(rewritten, options.replacements || {}, 'mysql'));
            return result;
        };
        const seed = async (business, login, tx) => {
            assert.ok(business && login);
            assert.equal(tx, transaction);
            seedCalls += 1;
        };
        dashboard.seedDashboardPermissions = seed;
        tracing.seedTracingPermissions = seed;
        const dao = require('../../src/Dao/mysql/superAdmin.dao');
        let sequence = 0;
        const payload = (email, telephone) => {
            sequence += 1;
            return { business: { name: `QA create regression ${sequence}`, plan: 'basic', subscription_status: 'trial', trial_days: 60 },
                adminUser: { create: true, name: 'QA initial admin', telephone: telephone || `009${String(sequence).padStart(7, '0')}`, email, password } };
        };
        const counts = async () => {
            const values = {};
            for (const table of ['business', 'login', 'appointment_config', 'ui_theme_configuration', 'admin_audit_log']) {
                const [[row]] = await connection.query(`SELECT COUNT(*) AS total FROM qa_create_${table}`);
                values[table] = row.total;
            }
            return values;
        };
        const beforeInvalid = await counts();
        const invalidEmails = [undefined, null, '', '   ', 'invalid', 'a@b', 'a b@example.test', `${'a'.repeat(250)}@example.test`];
        for (const email of invalidEmails) {
            const response = await dao.createBusiness(payload(email));
            assert.equal(response.status, 400, response.message);
            assert.match(response.message, /correo del administrador/);
            assert.deepEqual(await counts(), beforeInvalid, 'Invalid email cannot create partial records');
        }
        assert.equal(commits, 0);
        assert.equal(seedCalls, 0);
        console.log('PASS: missing/blank/malformed/oversized contact email rejected with 400 and no writes');

        for (const email of [' unique@example.test ']) {
            const request = payload(email);
            const response = await dao.createBusiness(request);
            assert.equal(response.status, 201, response.message);
            const [[row]] = await connection.query('SELECT email, telephone, password FROM qa_create_login WHERE id_login = ?', [response.data.adminUser.id_login]);
            assert.equal(row.email, email && email.trim() || null);
            assert.equal(row.telephone, request.adminUser.telephone, 'Leading zeros survive');
            assert.equal(await compare(password, row.password), true, 'Stored password remains hashed and usable');
            assert.equal(response.data.business.subscription_status, 'trial');
            assert.ok(response.data.business.trial_ends_at);
        }
        assert.equal(commits, 1);
        assert.equal(seedCalls, 2);
        console.log('PASS: initial admin with valid email; trimming, phone, password hash, trial and commit');

        const beforeConflicts = await counts();
        for (const request of [payload('different@example.test', '0001112233'), payload('EXISTING@example.test')]) {
            const response = await dao.createBusiness(request);
            assert.equal(response.status, 409, response.message);
            assert.deepEqual(await counts(), beforeConflicts, 'Conflict cannot leave partial business or admin records');
        }
        assert.equal(rollbacks, invalidEmails.length + 2);
        console.log('PASS: duplicate phone and case-insensitive duplicate email return 409 without writes');

        const noAdmin = payload(null);
        noAdmin.adminUser.create = false;
        assert.equal((await dao.createBusiness(noAdmin)).status, 201);
        assert.equal((await counts()).login, beforeConflicts.login);
        assert.equal(seedCalls, 2);
        console.log('PASS: business creation without initial admin');

        const beforeFailure = await counts();
        failLoginInsert = true;
        assert.equal((await dao.createBusiness(payload('rollback@example.test'))).status, 500);
        assert.deepEqual(await counts(), beforeFailure, 'Failed admin insert rolls back business and configuration');
        assert.equal(rollbacks, invalidEmails.length + 3);
        console.log('PASS: failed admin insert rolls back business/configuration; no audit of failed creation');
        console.log('PASS: one connection, temporary records only; permission helpers doubled, no persistent data changed');
    } finally {
        sequelize.query = original.query;
        sequelize.transaction = original.transaction;
        dashboard.seedDashboardPermissions = original.dashboard;
        tracing.seedTracingPermissions = original.tracing;
        await connection.end();
        await sequelize.close();
    }
}

main().catch(error => {
    // Never print SQL/replacements: failed inserts can contain credential hashes.
    console.error(`FAIL: ${error.code || error.name}: ${error.message}`);
    process.exitCode = 1;
});

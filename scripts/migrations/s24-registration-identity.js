'use strict';
// Defaults to READ ONLY. Never loads this module as part of app startup.
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const schema = require('./s24IdentitySchema');
const { inventory } = require('../../src/services/registration/identity');

async function audit(db) {
    const [accounts] = await db.query('SELECT id_login,telephone,email,active FROM login');
    const [columns] = await db.query(`SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLLATION_NAME
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND
        ((TABLE_NAME='login' AND COLUMN_NAME IN ('id_login','email','telephone','password'))
        OR (TABLE_NAME='business' AND COLUMN_NAME IN ('subscription_status','plan')))`);
    const [pending] = await db.query("SELECT COUNT(*) total FROM business WHERE subscription_status='pending_activation'");
    const [engines] = await db.query("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('business','login')");
    const [triggers] = await db.query("SELECT TRIGGER_NAME,EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='login'");
    const [writers] = await db.query(`SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()
        AND REPLACE(ROUTINE_DEFINITION,CHAR(96),'') REGEXP '(INSERT[[:space:]]+INTO[[:space:]]+login|UPDATE[[:space:]]+login)'`);
    const [tables] = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('auth_identity','registration_attempt')");
    const [routines] = await db.query("SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME IN ('s24_phone','s24_email','s24_claim_identity')");
    const identities = inventory(accounts);
    const objectsPresent = tables.length + routines.length + triggers.filter(t => t.TRIGGER_NAME.startsWith('s24_')).length;
    const unexpectedTriggers = triggers.some(t => !Object.hasOwn(schema.triggers, t.TRIGGER_NAME));
    const statusColumn = columns.find(c => c.TABLE_NAME === 'business' && c.COLUMN_NAME === 'subscription_status');
    const statusCompatible = Boolean(statusColumn && /^varchar\((\d+)\)$/.test(statusColumn.COLUMN_TYPE)
        && Number(statusColumn.COLUMN_TYPE.match(/\d+/)[0]) >= 18);
    return { checkedAt: new Date().toISOString(), readOnly: true, connections: 1,
        identities, columns, engines, triggers, writers, objectsPresent, pendingBusinesses: Number(pending[0].total),
        readyForInitialMigration: identities.ready && objectsPresent === 0 && !unexpectedTriggers
            && Number(pending[0].total) === 0 && statusCompatible && engines.length === 2 && engines.every(t => t.ENGINE === 'InnoDB') };
}

async function apply(db, report) {
    if (!report.readyForInitialMigration) throw new Error('S24_PREFLIGHT_FAILED');
    for (const sql of schema.statements) await db.query(sql);
    // DDL auto-commits. A partial DDL failure must be inspected, never hidden by
    // CREATE IF NOT EXISTS. Data population itself is atomic and repeatable only
    // after explicit inspection; no destructive automated down migration.
    await db.beginTransaction();
    try { await schema.backfill(db); await db.commit(); }
    catch (error) { await db.rollback(); throw error; }
}

async function main() {
    const args = process.argv.slice(2);
    const config = require('../../src/config/config');
    const writing = args.includes('--apply');
    const expected = args.includes('--expect-database') ? args[args.indexOf('--expect-database') + 1] : null;
    if (writing && (expected !== config.DATABASEMYSQL || !args.includes('--writers-stopped'))) {
        throw new Error('S24_EXACT_TARGET_AND_STOPPED_WRITERS_REQUIRED');
    }
    const db = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL,
        password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, connectTimeout: 10000, multipleStatements: false });
    try {
        await db.query('SET TRANSACTION READ ONLY');
        await db.beginTransaction();
        const report = await audit(db);
        await db.rollback();
        console.log(JSON.stringify(report, null, 2));
        if (!writing) return;
        if (!report.readyForInitialMigration) throw new Error('S24_PREFLIGHT_FAILED');
        const backup = path.resolve(__dirname, '../../../_schema_backups', 's24-' + new Date().toISOString().replace(/[:.]/g, '-'));
        await fs.mkdir(backup, { recursive: true });
        for (const table of ['login', 'business']) {
            const [[row]] = await db.query('SHOW CREATE TABLE ' + mysql.escapeId(table));
            await fs.writeFile(path.join(backup, table + '.sql'), row['Create Table'] + ';\n');
        }
        await apply(db, report);
        console.log('S24 identity migration applied; public registration remains unimplemented/closed.');
    } finally { await db.end(); }
}

if (require.main === module) main().catch(error => {
    // Driver messages may contain SQL values. Only stable error codes go to stdout.
    console.error(JSON.stringify({ failed: true, code: error.code || (/^S24_/.test(error.message) ? error.message : 'S24_MIGRATION_FAILED') }));
    process.exitCode = 1;
});
module.exports = { audit, apply };

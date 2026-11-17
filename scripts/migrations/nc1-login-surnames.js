'use strict';
// NC1 identidad simple — users: separate first and second surname in `login`.
// Additive and reentrant: two nullable columns, no trigger change, no backfill. `last_name` stays the joined
// surnames (derived by the application) so the S25 triggers keep composing `name`. Existing accounts are never
// split by spaces: their `last_name` is shown as historical until someone captures the surnames.
// Read-only by default. --apply / --revert require the exact target database and stopped writers.
const fs = require('node:fs/promises');
const path = require('node:path');

const COLUMNS = ['first_surname', 'second_surname'];

async function audit(db) {
    const [columns] = await db.query("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='login' AND COLUMN_NAME IN ('name','first_name','last_name','first_surname','second_surname')");
    const names = new Set(columns.map(row => row.COLUMN_NAME));
    const surnames = columns.filter(row => COLUMNS.includes(row.COLUMN_NAME));
    if (surnames.some(row => row.COLUMN_TYPE !== 'varchar(500)' || row.IS_NULLABLE !== 'YES')) throw Error('LOGIN_SURNAMES_INCOMPATIBLE_COLUMNS');
    return {
        // S25 (first_name/last_name) must already exist: this migration builds on it.
        ready: ['name', 'first_name', 'last_name'].every(name => names.has(name)),
        alreadyApplied: surnames.length === 2 && surnames.every(row => row.COLUMN_TYPE === 'varchar(500)' && row.IS_NULLABLE === 'YES'),
        presentColumns: surnames.map(row => row.COLUMN_NAME).sort()
    };
}

async function apply(db, backupDirectory) {
    const report = await audit(db);
    if (!report.ready) throw Error('LOGIN_SURNAMES_SCHEMA_NOT_READY');
    if (report.alreadyApplied) return report;
    const [[login]] = await db.query('SHOW CREATE TABLE login');
    await fs.mkdir(backupDirectory, { recursive: true });
    await fs.writeFile(path.join(backupDirectory, 'login-surnames-before.json'), JSON.stringify({ loginTable: login['Create Table'] }, null, 2), { flag: 'wx' });
    const missing = COLUMNS.filter(name => !report.presentColumns.includes(name));
    // DDL commits implicitly; additive nullable columns do not touch existing rows.
    if (missing.length) await db.query('ALTER TABLE login ' + missing.map(name => `ADD COLUMN ${name} VARCHAR(500) NULL DEFAULT NULL`).join(','));
    const after = await audit(db);
    if (!after.alreadyApplied) throw Error('LOGIN_SURNAMES_APPLY_INCOMPLETE');
    return after;
}

// Reversal keeps every captured value in a backup file before dropping the columns.
async function revert(db, backupDirectory) {
    const report = await audit(db);
    if (!report.presentColumns.length) return report;
    const select = ['id_login', 'id_business', 'last_name', ...report.presentColumns].join(',');
    const [rows] = await db.query(`SELECT ${select} FROM login WHERE ${report.presentColumns.map(name => name + ' IS NOT NULL').join(' OR ')}`);
    await fs.mkdir(backupDirectory, { recursive: true });
    await fs.writeFile(path.join(backupDirectory, 'login-surnames-values.json'), JSON.stringify(rows, null, 2), { flag: 'wx' });
    await db.query('ALTER TABLE login ' + report.presentColumns.map(name => `DROP COLUMN ${name}`).join(','));
    return { ...(await audit(db)), backedUpRows: rows.length };
}

async function main() {
    const mysql = require('mysql2/promise');
    const config = require('../../src/config/config');
    const args = process.argv.slice(2), applying = args.includes('--apply'), reverting = args.includes('--revert');
    const expected = args[args.indexOf('--expect-database') + 1];
    if ((applying || reverting) && (!args.includes('--expect-database') || expected !== config.DATABASEMYSQL || !args.includes('--writers-stopped'))) throw Error('LOGIN_SURNAMES_EXACT_TARGET_AND_STOPPED_WRITERS_REQUIRED');
    if (applying && reverting) throw Error('LOGIN_SURNAMES_ONE_ACTION');
    const db = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, connectTimeout: 10000 });
    try {
        const backupArg = args.indexOf('--backup-directory');
        if (backupArg >= 0 && (!args[backupArg + 1] || args[backupArg + 1].startsWith('--'))) throw Error('LOGIN_SURNAMES_BACKUP_DIRECTORY_REQUIRED');
        const backup = backupArg >= 0 ? path.resolve(args[backupArg + 1]) : path.resolve(__dirname, '../../_schema_backups/login-surnames-' + Date.now());
        const result = applying ? await apply(db, backup) : reverting ? await revert(db, backup) : await audit(db);
        console.log(JSON.stringify({ readOnly: !applying && !reverting, ...result, ...(applying || reverting ? { backup } : {}) }));
    } finally { await db.end(); }
}
if (require.main === module) main().catch(error => { console.error(/^LOGIN_SURNAMES_/.test(error.message) ? error.message : 'LOGIN_SURNAMES_MIGRATION_FAILED'); process.exitCode = 1; });
module.exports = { audit, apply, revert, COLUMNS };

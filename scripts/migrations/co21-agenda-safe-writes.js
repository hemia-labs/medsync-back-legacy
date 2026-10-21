// One connection, schema-only backup. No writes unless --apply and exact database match.
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
async function main() {
    const direction = args.includes('--direction') ? value('--direction') : 'up';
    if (!['up', 'down'].includes(direction) || !args.includes('--expect-database') || value('--expect-database') !== config.DATABASEMYSQL) {
        throw new Error('Use --direction up|down --expect-database <configured database> [--apply]. Stop writers before applying.');
    }
    const db = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL,
        password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, multipleStatements: false });
    try {
        const [columns] = await db.query("SELECT TABLE_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('appointment','appointment_config') AND column_name='revision'");
        const [tables] = await db.query("SELECT TABLE_NAME name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('appointment_write_request','appointment_audit','appointment_write_request_co21_rollback','appointment_audit_co21_rollback')");
        const names = tables.map(row => row.name);
        if (names.some(name => name.endsWith('_rollback'))) throw new Error('A previous rollback archive exists. Review replay/audit recovery before a forward migration; nothing was changed.');
        const applied = columns.length === 2 && names.length === 2;
        const absent = columns.length === 0 && names.length === 0;
        if (!applied && !absent) throw new Error('Partial migration state. Inspect it before retrying; nothing was changed.');
        if ((direction === 'up' && applied) || (direction === 'down' && absent)) { console.log('CO21: requested schema state already present; no writes.'); return; }
        if (!args.includes('--apply')) { console.log(`CO21 ${direction}: preflight PASS, no writes. Stop all writers and use --apply for the approved target.`); return; }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = path.resolve(__dirname, '../../../_schema_backups', `co21-${direction}-${stamp}`);
        await fs.mkdir(backup, { recursive: true });
        for (const table of ['appointment','appointment_config',...names]) {
            const [[row]] = await db.query('SHOW CREATE TABLE ' + mysql.escapeId(table));
            await fs.writeFile(path.join(backup, table + '.sql'), row['Create Table'] + ';\n');
        }
        const sql = await fs.readFile(path.resolve(__dirname, `../../Scripts_/20261021_agenda_co21_${direction}.sql`), 'utf8');
        // MySQL DDL commits implicitly. A failed statement requires inspection, not a claimed transaction rollback.
        for (const statement of sql.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.query(statement);
        console.log(`CO21 ${direction}: applied; schema backup: ${backup}. No Data export.`);
    } finally { await db.end(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });

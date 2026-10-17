const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');

(async () => {
    if (!process.argv.includes('--apply')) throw new Error('Use --apply to install the additive CO8 tables. No data export is performed.');
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    try {
        const backup = path.resolve(__dirname, '../../../_schema_backups', `co8-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        await fs.mkdir(backup, { recursive: true });
        for (const table of ['treatment_plan', 'treatment_plan_consent', 'patient_treatment']) {
            const [rows] = await connection.query(`SHOW CREATE TABLE \`${table}\``);
            await fs.writeFile(path.join(backup, `${table}.sql`), `${rows[0]['Create Table']};\n`);
        }
        const source = await fs.readFile(path.join(__dirname, 'co8-treatment-plan-continuity.sql'), 'utf8');
        for (const sql of source.split(';').map(value => value.trim()).filter(Boolean)) await connection.query(sql);
        console.log('CO8 additive tables installed. Existing clinical records retained. Schema-only backup:', backup);
    } finally { await connection.end(); }
})().catch(error => { console.error('CO8 migration failed:', error.code || error.message); process.exitCode = 1; });

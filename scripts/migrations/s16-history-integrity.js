const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');
const { schemaExportDirectory } = require('./workspace-schema-export');

(async () => {
    if (!process.argv.includes('--apply')) throw new Error('Use --apply para instalar revision e identidad historica.');
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    try {
        const workspace = path.resolve(__dirname, '../../..');
        const backup = path.join(workspace, '_schema_backups', `s16-history-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        await fs.mkdir(backup, { recursive: true });
        const [before] = await connection.query('SHOW CREATE TABLE clinical_histories');
        await fs.writeFile(path.join(backup, 'clinical_histories.sql'), `${before[0]['Create Table']};\n`);
        const [columns] = await connection.query('SHOW COLUMNS FROM clinical_histories');
        const names = new Set(columns.map(column => column.Field));
        const additions = { revision: 'INT UNSIGNED NOT NULL DEFAULT 0', responsible_snapshot_json: 'LONGTEXT NULL', finalizer_snapshot_json: 'LONGTEXT NULL' };
        const clauses = Object.entries(additions).filter(([name]) => !names.has(name)).map(([name, type]) => `ADD COLUMN ${name} ${type}`);
        if (clauses.length) await connection.query(`ALTER TABLE clinical_histories ${clauses.join(', ')}`);
        // Never backfill present-day identity as if it had been captured at historical finalization.
        const tableDirectory = schemaExportDirectory(workspace, 'Tables');
        if (tableDirectory) {
            const target = path.join(tableDirectory, 'clinical_histories.sql');
            try { await fs.copyFile(target, path.join(backup, 'clinical_histories-export.sql')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const [after] = await connection.query('SHOW CREATE TABLE clinical_histories');
            await fs.writeFile(target, `DROP TABLE IF EXISTS \`clinical_histories\`;\n${after[0]['Create Table']};\n`);
        }
        console.log(`S16 history: ${clauses.length} columnas agregadas; sin reescribir historias. Backup de esquema: ${backup}`);
    } finally { await connection.end(); }
})().catch(error => { console.error('S16 history migration:', error.code || error.message); process.exitCode = 1; });

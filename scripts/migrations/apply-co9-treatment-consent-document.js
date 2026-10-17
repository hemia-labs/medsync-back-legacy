const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');
const { schemaExportDirectory } = require('./workspace-schema-export');
(async () => {
    if (!process.argv.includes('--apply')) throw new Error('Use --apply for the additive CO9 table.');
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    try {
        const workspace = path.resolve(__dirname, '../../..');
        const backup = path.join(workspace, '_schema_backups', `co9-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        await fs.mkdir(backup, { recursive: true });
        for (const table of ['patient_documents', 'treatment_plan_consent', 'treatment_plan_consent_version', 'document_signature_requests']) {
            const [rows] = await connection.query(`SHOW CREATE TABLE \`${table}\``);
            await fs.writeFile(path.join(backup, `${table}.sql`), `${rows[0]['Create Table']};\n`);
        }
        const source = await fs.readFile(path.join(__dirname, 'co9-treatment-consent-document.sql'), 'utf8');
        await connection.query(source);
        const [rows] = await connection.query('SHOW CREATE TABLE treatment_plan_consent_document');
        const tableDirectory = schemaExportDirectory(workspace, 'Tables');
        if (tableDirectory) {
            const target = path.join(tableDirectory, 'treatment_plan_consent_document.sql');
            try { await fs.copyFile(target, path.join(backup, 'treatment_plan_consent_document.sql')); } catch(error) { if(error.code !== 'ENOENT') throw error; }
            await fs.writeFile(target, `${rows[0]['Create Table']};\n`);
        }
        console.log('CO9 additive binding table installed. Schema-only backup:', backup);
    } finally { await connection.end(); }
})().catch(error => { console.error('CO9 migration failed:', error.code || error.message); process.exitCode = 1; });

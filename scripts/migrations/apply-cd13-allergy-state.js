const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');
const { schemaExportDirectory } = require('./workspace-schema-export');
(async () => {
    if (!process.argv.includes('--apply')) throw new Error('Use --apply para instalar el estado de alergias.');
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    try {
        const workspace = path.resolve(__dirname, '../../..');
        const backup = path.join(workspace, '_schema_backups', `cd13-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        await fs.mkdir(backup, { recursive: true });
        const [before] = await connection.query('SHOW CREATE TABLE allergy');
        await fs.writeFile(path.join(backup, 'allergy.sql'), `${before[0]['Create Table']};\n`);
        const [columns] = await connection.query('SHOW COLUMNS FROM allergy');
        const names = new Set(columns.map(c => c.Field));
        const additions = { review_status: 'VARCHAR(30) NULL', revision: 'INT UNSIGNED NOT NULL DEFAULT 0', reviewed_at: 'DATETIME(3) NULL', reviewed_by: 'VARCHAR(36) NULL' };
        for (const [name, type] of Object.entries(additions)) if (!names.has(name)) await connection.query(`ALTER TABLE allergy ADD COLUMN ${name} ${type}`);
        await connection.query(`CREATE TABLE IF NOT EXISTS patient_allergy_events (
            id_event VARCHAR(36) NOT NULL PRIMARY KEY, business_id VARCHAR(50) NOT NULL, patient_id VARCHAR(36) NOT NULL,
            user_id VARCHAR(36) NOT NULL, revision INT UNSIGNED NOT NULL, snapshot_json LONGTEXT NOT NULL, created_at DATETIME(3) NOT NULL,
            KEY idx_allergy_events_patient (business_id, patient_id, revision)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        const triggerName = 'allergy_preserve_reviewed_state';
        const [triggers] = await connection.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?', [triggerName]);
        const triggerSql = `CREATE TRIGGER allergy_preserve_reviewed_state BEFORE UPDATE ON allergy FOR EACH ROW
            SET NEW.has_allergy = IF(NEW.revision = OLD.revision AND OLD.review_status IS NOT NULL, OLD.has_allergy, NEW.has_allergy),
                NEW.description = IF(NEW.revision = OLD.revision AND OLD.review_status IS NOT NULL, OLD.description, NEW.description),
                NEW.review_status = IF(NEW.revision = OLD.revision, OLD.review_status, NEW.review_status),
                NEW.reviewed_at = IF(NEW.revision = OLD.revision, OLD.reviewed_at, NEW.reviewed_at),
                NEW.reviewed_by = IF(NEW.revision = OLD.revision, OLD.reviewed_by, NEW.reviewed_by)`;
        if (!triggers.length) await connection.query(triggerSql);
        const triggerDirectory = schemaExportDirectory(workspace, 'Triggers');
        const tableDirectory = schemaExportDirectory(workspace, 'Tables');
        if (triggerDirectory && tableDirectory) {
            const triggerTarget = path.join(triggerDirectory, `${triggerName}.sql`);
            try { await fs.copyFile(triggerTarget, path.join(backup, `${triggerName}-export.sql`)); } catch(e) { if(e.code !== 'ENOENT') throw e; }
            await fs.writeFile(triggerTarget, `DROP TRIGGER IF EXISTS allergy_preserve_reviewed_state;\n${triggerSql};\n`);
            for (const table of ['allergy', 'patient_allergy_events']) {
                const target = path.join(tableDirectory, `${table}.sql`);
                try { await fs.copyFile(target, path.join(backup, `${table}-export.sql`)); } catch(e) { if(e.code !== 'ENOENT') throw e; }
                const [rows] = await connection.query(`SHOW CREATE TABLE ${table}`);
                await fs.writeFile(target, `DROP TABLE IF EXISTS \`${table}\`;\n${rows[0]['Create Table']};\n`);
            }
        }
        console.log('CD13: migracion aditiva aplicada; sin conversion de datos. Backup de esquema:', backup);
    } finally { await connection.end(); }
})().catch(error => { console.error('CD13 migration:', error.code || error.message); process.exitCode = 1; });

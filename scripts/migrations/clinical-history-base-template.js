'use strict';
// Deployment data prerequisite, not DDL. Reads never seed templates implicitly.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { baseClinicalHistoryTemplate } = require('../../src/domain/clinicalHistory/clinicalHistoryBaseTemplate');

const TEMPLATE_ID = 'f2109a0e-640c-4c65-8a41-77279ca38fe4';
const VERSION_ID = 'cbd29f06-fd06-4537-8e82-19f7d289fb4d';

async function audit(db) {
    const [rows] = await db.query(`SELECT t.id_clinical_history_template, t.is_active, t.deleted_at,
        v.id_clinical_history_template_version, v.version_number, v.schema_json
        FROM clinical_history_templates t LEFT JOIN clinical_history_template_versions v
        ON v.clinical_history_template_id=t.id_clinical_history_template
        AND v.version_number=(SELECT MAX(v2.version_number) FROM clinical_history_template_versions v2
            WHERE v2.clinical_history_template_id=t.id_clinical_history_template)
        WHERE t.business_id IS NULL AND t.is_system_template=1 ORDER BY t.created_at ASC`);
    const active = rows.find(row => Number(row.is_active) === 1 && row.deleted_at === null && row.id_clinical_history_template_version);
    if (active) {
        let schema;
        try { schema = typeof active.schema_json === 'string' ? JSON.parse(active.schema_json) : active.schema_json; } catch { /* fail closed below */ }
        if (!schema || !Array.isArray(schema.sections) || !schema.sections.length) throw Error('HISTORY_BASE_EXISTING_SCHEMA_INVALID');
    }
    return { ready: Boolean(active), systemTemplates: rows.length,
        templateId: active?.id_clinical_history_template || null,
        versionId: active?.id_clinical_history_template_version || null };
}

async function apply(db, backupDirectory) {
    if (!backupDirectory) throw Error('HISTORY_BASE_BACKUP_REQUIRED');
    const [[target]] = await db.query('SELECT DATABASE() db, @@hostname host');
    const lock = 'history-base:' + crypto.createHash('sha256').update(target.db).digest('hex').slice(0, 40);
    const [[locked]] = await db.query('SELECT GET_LOCK(?, 10) acquired', [lock]);
    if (Number(locked.acquired) !== 1) throw Error('HISTORY_BASE_LOCK_UNAVAILABLE');
    let started = false;
    try {
        await db.beginTransaction(); started = true;
        const before = await audit(db);
        if (before.ready) { await db.commit(); started = false; return { ...before, created: false }; }
        // A disabled/orphaned system template is an explicit configuration problem, not permission to replace it.
        if (before.systemTemplates) throw Error('HISTORY_BASE_EXISTING_TEMPLATE_REQUIRES_REVIEW');
        await fs.mkdir(backupDirectory, { recursive: true });
        await fs.writeFile(path.join(backupDirectory, 'history-base-before.json'), JSON.stringify({ target, before, templateId: TEMPLATE_ID, versionId: VERSION_ID }), { flag: 'wx', mode: 0o600 });
        await db.query(`INSERT INTO clinical_history_templates
            (id_clinical_history_template,business_id,name,description,is_system_template,is_active)
            VALUES (?,NULL,?,?,1,1)`, [TEMPLATE_ID, 'Historia clínica base', 'Formato base del sistema para consultorios sin formato personalizado.']);
        await db.query(`INSERT INTO clinical_history_template_versions
            (id_clinical_history_template_version,clinical_history_template_id,version_number,schema_json)
            VALUES (?,?,1,?)`, [VERSION_ID, TEMPLATE_ID, JSON.stringify(baseClinicalHistoryTemplate)]);
        const after = await audit(db);
        if (!after.ready || after.versionId !== VERSION_ID) throw Error('HISTORY_BASE_POSTCONDITION_FAILED');
        await db.commit(); started = false;
        return { ...after, created: true };
    } catch (error) {
        if (started) await db.rollback();
        throw error;
    } finally { await db.query('SELECT RELEASE_LOCK(?)', [lock]); }
}

async function main() {
    const args = process.argv.slice(2);
    const option = key => { const at = args.indexOf(key); return at >= 0 ? args[at + 1] : null; };
    const applying = args.includes('--apply');
    const config = require('../../src/config/config');
    const mysql = require('mysql2/promise');
    const db = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL,
        password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, connectTimeout: 10000 });
    try {
        const [[target]] = await db.query('SELECT DATABASE() db, @@hostname host');
        if (applying && (option('--expect-database') !== target.db || option('--expect-hostname') !== target.host || !option('--backup-directory'))) throw Error('HISTORY_BASE_EXACT_TARGET_AND_BACKUP_REQUIRED');
        const result = applying ? await apply(db, path.resolve(option('--backup-directory'))) : await audit(db);
        console.log(JSON.stringify({ readOnly: !applying, target, ...result }));
        if (!result.ready) process.exitCode = 2;
    } finally { await db.end(); }
}
if (require.main === module) main().catch(error => {
    console.error(JSON.stringify({ error: 'HISTORY_BASE_FAILED', code: /^[A-Z0-9_]+$/.test(error.code || error.message) ? (error.code || error.message) : 'CHECK_FAILED' }));
    process.exitCode = 1;
});
module.exports = { audit, apply, TEMPLATE_ID, VERSION_ID };

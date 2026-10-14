const fs = require('node:fs');
const path = require('node:path');
const { schemaExportDirectory } = require('./workspace-schema-export');

// Accept an existing mysql2 connection so the coordinated migration uses one connection.
async function migrate(db) {
    const added = [];
    const [columns] = await db.query('SHOW COLUMNS FROM tracing');
    const known = new Set(columns.map(row => row.Field));
    const definitions = {
        revision: 'INT UNSIGNED NOT NULL DEFAULT 1',
        status: "VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active'",
        updated_at: 'DATETIME DEFAULT NULL', updated_by: 'VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL',
        cancelled_at: 'DATETIME DEFAULT NULL', cancelled_by: 'VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL',
        cancellation_reason: 'VARCHAR(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL'
    };
    for (const [column, definition] of Object.entries(definitions)) {
        if (!known.has(column)) { await db.query(`ALTER TABLE tracing ADD COLUMN ${column} ${definition}`); added.push(column); }
    }
    await db.query(`CREATE TABLE IF NOT EXISTS tracing_revision (
        id_tracing_revision VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
        id_tracing VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
        id_business VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
        id_person VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
        revision INT UNSIGNED NOT NULL,
        action VARCHAR(30) COLLATE utf8mb4_unicode_ci NOT NULL,
        snapshot_json LONGTEXT COLLATE utf8mb4_unicode_ci NOT NULL,
        change_reason VARCHAR(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
        recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        recorded_by VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
        PRIMARY KEY (id_tracing_revision), UNIQUE KEY ux_tracing_revision (id_tracing, revision),
        KEY ix_tracing_revision_patient (id_business, id_person, id_tracing),
        CONSTRAINT fk_tracing_revision_record FOREIGN KEY (id_tracing) REFERENCES tracing (id_tracing)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const permissions = [
        ['PERM-TRACING-CREATE', 'tracing.create', 'Capturar seguimiento', 'Permite registrar seguimientos clinicos.'],
        ['PERM-TRACING-CORRECT', 'tracing.correct', 'Corregir seguimiento', 'Permite corregir con motivo y conservar versiones anteriores.'],
        ['PERM-TRACING-CANCEL', 'tracing.cancel', 'Anular seguimiento', 'Permite anular con motivo sin eliminar el contenido.']
    ];
    let seeded = 0;
    await db.beginTransaction();
    try {
        for (const [id, code, name, description] of permissions) {
            const [exists] = await db.query('SELECT id_cat_permission FROM cat_permission WHERE code = ?', [code]);
            if (!exists.length) await db.query(`INSERT INTO cat_permission
                (id_cat_permission, code, name, description, sec, value, active, is_active, created_at)
                VALUES (?, ?, ?, ?, ?, 'Seguimiento', 1, 1, NOW())`, [id, code, name, description, 81 + permissions.findIndex(p => p[0] === id)]);
            const permissionId = exists.length ? exists[0].id_cat_permission : id;
            // Existing effective monitoring denial wins. No global role grants are modified.
            const [result] = await db.query(`INSERT IGNORE INTO business_role_permission (id_business, id_rol, id_cat_permission, active)
                SELECT DISTINCT l.id_business, l.id_rol, ?, 1 FROM login l
                INNER JOIN rol r ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci AND r.active = 1
                INNER JOIN cat_permission cp ON cp.code = 'px.tab.monitoring' AND cp.active = 1
                LEFT JOIN permission_rol pr ON pr.id_rol = l.id_rol AND pr.id_cat_permission = cp.id_cat_permission
                LEFT JOIN business_role_permission bp ON bp.id_business = l.id_business AND bp.id_rol = l.id_rol AND bp.id_cat_permission = cp.id_cat_permission
                WHERE l.active = 1 AND l.id_business IS NOT NULL AND COALESCE(bp.active, pr.active, 0) = 1
                  AND (EXISTS (SELECT 1 FROM doctor_professional_profile d WHERE d.id_login = l.id_login AND d.id_business = l.id_business AND d.is_active = 1)
                    ${code === 'tracing.create' ? `OR EXISTS (SELECT 1 FROM cat_permission ch
                        LEFT JOIN permission_rol chr ON chr.id_rol = l.id_rol AND chr.id_cat_permission = ch.id_cat_permission
                        LEFT JOIN business_role_permission chb ON chb.id_business = l.id_business AND chb.id_rol = l.id_rol AND chb.id_cat_permission = ch.id_cat_permission
                        WHERE ch.code = 'clinical_history.edit_draft' AND ch.active = 1 AND COALESCE(chb.active, chr.active, 0) = 1)` : ''})`, [permissionId]);
            seeded += result.affectedRows;
        }
        await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    // Old SP_aux_tracing could omit the tenant. The existing person FK identifies
    // the tenant unambiguously; never silently rewrite a contradictory non-null tenant.
    const [backfill] = await db.query(`UPDATE tracing t INNER JOIN person p ON p.id_person = t.id_person
        SET t.id_business = p.id_business WHERE t.id_business IS NULL AND p.id_business IS NOT NULL`);
    const [conflicts] = await db.query(`SELECT COUNT(*) AS total FROM tracing t INNER JOIN person p ON p.id_person = t.id_person
        WHERE t.id_business IS NOT NULL AND p.id_business IS NOT NULL AND t.id_business <> p.id_business`);
    return { added, table: 'tracing_revision', seededTenantPermissions: seeded, globalRolePermissionsChanged: 0,
        backfilledLegacyTenant: backfill.affectedRows, conflictingTenantRowsUnchanged: Number(conflicts[0].total) };
}

async function main() {
    if (!process.argv.includes('--apply')) throw new Error('Use --apply para instalar la conservacion del seguimiento y exportar su esquema.');
    const mysql = require('mysql2/promise');
    const c = require('../../src/config/config');
    const db = await mysql.createConnection({ host: c.HOSTMYSQL, port: c.PORTMYSQL, user: c.USERMYSQL, password: c.PASSWORDMYSQL, database: c.DATABASEMYSQL });
    try {
        const workspace = path.resolve(__dirname, '../../..');
        const backup = path.join(workspace, '_schema_backups', `s16-tracing-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        fs.mkdirSync(backup, { recursive: true });
        const [revisionTable] = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tracing_revision'");
        for (const table of ['tracing', 'cat_permission', 'business_role_permission', ...(revisionTable.length ? ['tracing_revision'] : [])]) {
            const [rows] = await db.query(`SHOW CREATE TABLE ${table}`);
            fs.writeFileSync(path.join(backup, `${table}.sql`), `${rows[0]['Create Table']};\n`);
        }
        const exportedTables = ['tracing', 'tracing_revision'];
        const tablesDirectory = schemaExportDirectory(workspace, 'Tables');
        for (const table of tablesDirectory ? exportedTables : []) {
            const target = path.join(tablesDirectory, `${table}.sql`);
            try { fs.copyFileSync(target, path.join(backup, `${table}-export.sql`)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const result = await migrate(db);
        for (const table of tablesDirectory ? exportedTables : []) {
            const [rows] = await db.query(`SHOW CREATE TABLE ${table}`);
            fs.writeFileSync(path.join(tablesDirectory, `${table}.sql`), `DROP TABLE IF EXISTS \`${table}\`;\n${rows[0]['Create Table']};\n`);
        }
        console.log(JSON.stringify({ ...result, backup, exportedTables: tablesDirectory ? exportedTables : [] }));
    } finally { await db.end(); }
}

module.exports = { migrate };
if (require.main === module) main().catch(error => { console.error('S16 tracing migration:', error.code || error.message); process.exitCode = 1; });

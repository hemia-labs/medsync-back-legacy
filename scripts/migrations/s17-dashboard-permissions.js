const fs = require('node:fs');
const path = require('node:path');
const permissions = [
    ['PERM-DASH-OPERATIONS', 'dashboard.operations', 'Indicadores operativos', 'Consultar citas y actividad administrativa. No concede lectura del contenido clinico.', 'Indicadores'],
    ['PERM-DASH-CLINICAL', 'dashboard.clinical', 'Indicadores clinicos', 'Consultar agregados de historias, recetas y tratamientos. No concede acceso al contenido del expediente.', 'Indicadores'],
    ['PERM-DASH-FINANCIAL', 'dashboard.financial', 'Indicadores economicos', 'Consultar importes estimados y estadisticas economicas disponibles. Requiere asignacion explicita.', 'Indicadores'],
    ['PERM-DASH-ALL', 'dashboard.scope.all', 'Indicadores de todo el consultorio', 'Ampliar las familias autorizadas a todo el consultorio. No concede familias adicionales.', 'Indicadores'],
    ['PERM-CH-INTAKE', 'clinical_history.intake', 'Captura inicial en recepcion', 'Consultar y capturar el motivo y relato referido por el paciente en el borrador. No permite ver el resto de la historia, finalizar ni firmar.', 'Historia clinica']
];

async function migrate(db) {
    // Import inside migrate after the caller has loaded the established config.
    const { seedSql, receptionSafetySql, assistantTreatmentSql } = require('../../src/util/dashboardAccess');
    await db.beginTransaction();
    try {
        let created = 0;
        for (const [id, code, name, description, group] of permissions) {
            const [exists] = await db.query('SELECT id_cat_permission FROM cat_permission WHERE code = ?', [code]);
            if (!exists.length) {
                await db.query(`INSERT INTO cat_permission (id_cat_permission, code, name, description, sec, value, active, is_active, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 1, 1, NOW())`, [id, code, name, description, 90 + created, group]);
                created++;
            }
        }
        // No permission_rol changes: inherited global defaults cannot silently
        // expand these new data families. INSERT IGNORE preserves tenant denials.
        const [reception] = await db.query(receptionSafetySql.replaceAll(':business', 'NULL').replaceAll(':login', 'NULL'));
        const [assistant] = await db.query(assistantTreatmentSql.replaceAll(':business', 'NULL').replaceAll(':login', 'NULL'));
        const [result] = await db.query(seedSql.replaceAll(':business', 'NULL').replaceAll(':login', 'NULL'));
        await db.commit();
        return { createdPermissions: created, seededTenantPermissions: result.affectedRows,
            narrowedInheritedReceptionPermissions: reception.affectedRows, accessibleAssistantTreatmentTabs: assistant.affectedRows,
            financialAutoGrants: 0, intakeAutoGrants: 0, globalRolePermissionsChanged: 0 };
    } catch (error) { await db.rollback(); throw error; }
}

async function main() {
    if (!process.argv.includes('--apply')) throw new Error('Use --apply para instalar los permisos S17.');
    const c = require('../../src/config/config');
    const db = await require('mysql2/promise').createConnection({ host: c.HOSTMYSQL, port: c.PORTMYSQL, user: c.USERMYSQL, password: c.PASSWORDMYSQL, database: c.DATABASEMYSQL });
    try {
        const workspace = path.resolve(__dirname, '../../..');
        const backup = path.join(workspace, '_schema_backups', `s17-permissions-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        fs.mkdirSync(backup, { recursive: true });
        for (const table of ['cat_permission', 'business_role_permission']) {
            const [rows] = await db.query(`SHOW CREATE TABLE ${table}`);
            fs.writeFileSync(path.join(backup, `${table}.sql`), `${rows[0]['Create Table']};\n`);
        }
        console.log(JSON.stringify({ ...(await migrate(db)), backup }));
    } finally { await db.end(); }
}

module.exports = { migrate, permissions };
if (require.main === module) main().catch(error => { console.error('S17 permisos:', error.code || error.message); process.exitCode = 1; });

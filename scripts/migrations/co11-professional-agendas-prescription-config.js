// Additive schema, versioned routine backup, independent professional defaults.
// --clear-dummy-appointments retires only verified QA/dummy appointments.
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { v4: uuid } = require('uuid');
const config = require('../../src/config/config');
const sqlRoot = path.join(__dirname, 'sql');

async function main() {
    const db = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.resolve(__dirname, '../../../_schema_backups', `co11-${stamp}`);
    await fs.mkdir(backup, { recursive: true });
    async function column(table, name, definition) {
        const [rows] = await db.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, name]);
        if (!rows.length) await db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
    async function index(table, name, sql) {
        const [rows] = await db.query('SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [table, name]);
        if (!rows.length) await db.query(`ALTER TABLE ${table} ADD ${sql}`);
    }
    const procedures = ['SP_appointment_config_get', 'SP_appointment_config_save', 'SP_appointment_get', 'SP_appointment_list', 'SP_appointment_save'];
    try {
        for (const table of ['appointment', 'appointment_config', 'prescription_config']) {
            const [rows] = await db.query(`SHOW CREATE TABLE ${table}`);
            await fs.writeFile(path.join(backup, `${table}.sql`), rows[0]['Create Table'] + ';\n');
        }
        for (const procedure of procedures) {
            const [rows] = await db.query(`SHOW CREATE PROCEDURE ${procedure}`);
            await fs.writeFile(path.join(backup, `${procedure}.sql`), rows[0]['Create Procedure'] + ';\n');
        }
        await column('appointment', 'doctor_profile_id', 'varchar(50) COLLATE utf8mb4_unicode_ci NULL');
        await column('appointment', 'doctor_name_snapshot', 'varchar(250) COLLATE utf8mb4_unicode_ci NULL');
        await column('appointment_config', 'doctor_profile_id', 'varchar(50) COLLATE utf8mb4_unicode_ci NULL');
        await column('prescription_config', 'doctor_profile_id', 'varchar(50) COLLATE utf8mb4_unicode_ci NULL');
        await index('appointment', 'idx_appointment_doctor_date', 'KEY idx_appointment_doctor_date (id_business, doctor_profile_id, active, appointment_date, start_time, end_time)');
        await index('appointment_config', 'ux_appointment_config_doctor', 'UNIQUE KEY ux_appointment_config_doctor (id_business, doctor_profile_id)');
        const [oldIndex] = await db.query("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prescription_config' AND INDEX_NAME = 'ux_prescription_config_business'");
        if (oldIndex.length) await db.query('ALTER TABLE prescription_config DROP INDEX ux_prescription_config_business');
        await index('prescription_config', 'ux_prescription_config_doctor', 'UNIQUE KEY ux_prescription_config_doctor (id_business, doctor_profile_id)');
        for (const procedure of procedures) {
            const text = await fs.readFile(path.join(sqlRoot, `${procedure}.sql`), 'utf8');
            await db.query(`DROP PROCEDURE IF EXISTS ${procedure}`);
            await db.query(text);
        }
        const [doctors] = await db.query('SELECT d.id_business, d.id_doctor_professional_profile FROM doctor_professional_profile d JOIN login l ON l.id_login = d.id_login AND l.id_business = d.id_business WHERE d.is_active = 1 AND l.active = 1');
        let agendas = 0, prescriptions = 0, retired = 0;
        await db.beginTransaction();
        for (const d of doctors) {
            const [existing] = await db.query('SELECT 1 FROM appointment_config WHERE id_business = ? AND doctor_profile_id = ?', [d.id_business, d.id_doctor_professional_profile]);
            if (!existing.length) {
                const [result] = await db.query('CALL SP_appointment_config_get(?, NULL)', [d.id_business]);
                let base = result[0][0].config;
                if (typeof base === 'string') base = JSON.parse(base);
                const count = doctors.filter(other => other.id_business === d.id_business).length;
                base.enabled = count === 1 ? !!base.enabled : false;
                await db.query('CALL SP_appointment_config_save(?, NULL, ?, ?)', [JSON.stringify(base), d.id_business, d.id_doctor_professional_profile]);
                agendas++;
            }
            const [own] = await db.query('SELECT 1 FROM prescription_config WHERE id_business = ? AND doctor_profile_id = ?', [d.id_business, d.id_doctor_professional_profile]);
            if (!own.length) {
                const [shared] = await db.query('SELECT * FROM prescription_config WHERE id_business = ? AND doctor_profile_id IS NULL AND active = 1 LIMIT 1', [d.id_business]);
                if (shared.length) {
                    const row = { ...shared[0], id_prescription_config: uuid(), doctor_profile_id: d.id_doctor_professional_profile };
                    await db.query('INSERT INTO prescription_config SET ?', [row]);
                    prescriptions++;
                }
            }
        }
        if (process.argv.includes('--clear-dummy-appointments')) {
            const [unsafe] = await db.query("SELECT COUNT(*) n FROM appointment a LEFT JOIN business b ON b.id_business = a.id_business WHERE a.active = 1 AND NOT (COALESCE(b.name,'') LIKE 'QA %' OR COALESCE(b.name,'') LIKE '%dummy%' OR a.id_appointment LIKE 'QA%')");
            if (Number(unsafe[0].n)) throw new Error('Non-dummy appointments found; cleanup cancelled.');
            const [result] = await db.query('UPDATE appointment SET active = 0, updated_at = NOW() WHERE active = 1');
            retired = result.affectedRows;
        }
        await db.commit();
        console.log(JSON.stringify({ backup, seededAgendas: agendas, seededPrescriptionConfigs: prescriptions, retiredDummyAppointments: retired }));
    } catch (error) {
        await db.rollback();
        console.error('CO11 migration failed:', error.message);
        process.exitCode = 1;
    } finally { await db.end(); }
}
main().catch(() => { console.error('CO11 connection failed.'); process.exitCode = 1; });

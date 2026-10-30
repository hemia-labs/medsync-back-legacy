'use strict';
// Read-only metadata checks; never prints connection settings or clinical content.
const fs = require('node:fs/promises');
const path = require('node:path');
async function inspect(db) {
    const [tables] = await db.query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    const required = ['person','login','cat_tooth','cat_type_tooth','odontogramv1','odontogramDetailv1','clinical_module_config','cat_permission'];
    const missing = required.filter(name => !tables.some(table => table.TABLE_NAME === name));
    if (missing.length) return { pass: false, missing_tables: missing };
    const [columns] = await db.query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)', [required]);
    const [teeth] = await db.query('SELECT id_tooth,sec FROM cat_tooth');
    const validTeeth = teeth.length === 52 && new Set(teeth.map(tooth => Number(tooth.sec))).size === 52 && teeth.every(tooth => /^(?:[1-4][1-8]|[5-8][1-5])$/.test(String(tooth.sec)));
    const [active] = await db.query(`SELECT COUNT(*) AS count FROM (SELECT id_person FROM odontogramv1 WHERE active=1 AND is_active=1 GROUP BY id_person HAVING COUNT(*)>1) duplicate_active`);
    const [notes] = await db.query('SELECT COUNT(*) AS count FROM odontogramDetailv1 WHERE active=1 AND is_active=1 AND (treatment IS NULL OR CHAR_LENGTH(treatment)>1000)');
    const [duplicates] = await db.query(`SELECT COUNT(*) AS count FROM (SELECT id_odontogramv1,id_tooth FROM odontogramDetailv1 WHERE active=1 AND is_active=1 GROUP BY id_odontogramv1,id_tooth HAVING COUNT(*)>1) duplicate_notes`);
    const engines = required.filter(name => String(tables.find(table => table.TABLE_NAME === name).ENGINE).toLowerCase() !== 'innodb');
    return { pass: validTeeth && !Number(active[0].count) && !Number(notes[0].count) && !Number(duplicates[0].count) && !engines.length,
        checked_at: new Date().toISOString(), connection_values_redacted: true,
        catalog: { count: teeth.length, valid_52_fdi: validTeeth }, duplicate_active_patients: Number(active[0].count),
        incompatible_notes: Number(notes[0].count), duplicate_notes: Number(duplicates[0].count), non_innodb_tables: engines,
        schema: columns, tables: tables.filter(table => required.includes(table.TABLE_NAME) || table.TABLE_NAME.startsWith('odontogram_v2_')) };
}
module.exports = { inspect };
if (require.main === module) (async () => {
    const config = require('../../src/config/config');
    const db = await require('mysql2/promise').createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, connectTimeout: 10000 });
    try {
        const report = await inspect(db);
        const target = path.resolve(__dirname, '../../../roadmap/evidence/CO26');
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, 'configured-db-preflight.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ pass: report.pass, missing_tables: report.missing_tables || [], catalog: report.catalog, duplicate_active_patients: report.duplicate_active_patients, incompatible_notes: report.incompatible_notes, duplicate_notes: report.duplicate_notes, non_innodb_tables: report.non_innodb_tables }));
        if (!report.pass) process.exitCode = 1;
    } finally { await db.end(); }
})().catch(error => { console.error('CO26 preflight failed:', error.code || 'CHECK_FAILED'); process.exitCode = 1; });

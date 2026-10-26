'use strict';

// Run with the existing environment loader. Defaults to a read-only preflight.
// Stop all patient writers before --apply; MySQL DDL is not transactional.
async function migrate(connection, apply = false) {
    const [duplicates] = await connection.query('SELECT COUNT(*) AS n FROM (SELECT code FROM person GROUP BY code HAVING COUNT(*) > 1) conflicts');
    if (Number(duplicates[0].n)) throw new Error('PATIENT_CODE_DUPLICATES_REQUIRE_REVIEW');
    const [max] = await connection.query("SELECT COALESCE(MAX(CAST(code AS UNSIGNED)),0) AS n FROM person WHERE code REGEXP '^[0-9]{1,8}$'");
    const next = Number(max[0].n) + 1;
    if (next > 99999999) throw new Error('PATIENT_CODE_RANGE_EXHAUSTED');
    if (!apply) return { ready: true, applied: false };
    await connection.query('CREATE TABLE IF NOT EXISTS patient_code_counter (singleton TINYINT NOT NULL PRIMARY KEY, next_value BIGINT UNSIGNED NOT NULL, CONSTRAINT chk_patient_code_singleton CHECK (singleton = 1)) ENGINE=InnoDB');
    await connection.query('INSERT INTO patient_code_counter(singleton,next_value) VALUES(1,?) ON DUPLICATE KEY UPDATE next_value=GREATEST(next_value,VALUES(next_value))', [next]);
    const [indexes] = await connection.query('SHOW INDEX FROM person');
    const unique = indexes.filter(row => Number(row.Non_unique) === 0 && row.Column_name === 'code')
        .some(row => indexes.filter(other => other.Key_name === row.Key_name).length === 1);
    if (!unique) await connection.query('ALTER TABLE person ADD UNIQUE KEY uq_person_code (code)');
    return { ready: true, applied: true };
}
module.exports = { migrate };
if (require.main === module) {
    require('../../src/config/env');
    const config = require('../../src/config/config');
    const mysql = require('mysql2/promise');
    (async () => {
        if (process.argv.includes('--apply') && !process.argv.includes('--writers-stopped')) throw new Error('REQUIRES_WRITERS_STOPPED');
        const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
        try { console.log(await migrate(connection, process.argv.includes('--apply'))); }
        finally { await connection.end(); }
    })().catch(() => { console.error('Patient code migration failed. Review duplicates, range and schema permissions in the authorized environment.'); process.exitCode = 1; });
}

'use strict';
const { QueryTypes } = require('sequelize');
function createReadiness(db, timeoutMs = 2000) {
    let initialized = false;
    let pending = null;
    return {
        async initialize() {
            await db.sync({ force: false });
            const rows = await db.query('SELECT next_value FROM patient_code_counter WHERE singleton = 1', { type: QueryTypes.SELECT });
            if (!rows.length || Number(rows[0].next_value) < 1 || Number(rows[0].next_value) > 99999999) throw Error('PATIENT_CODE_MIGRATION_REQUIRED');
            const indexes = await db.query('SHOW INDEX FROM person', { type: QueryTypes.SELECT });
            const unique = indexes.filter(row => Number(row.Non_unique) === 0 && row.Column_name === 'code')
                .some(row => indexes.filter(other => other.Key_name === row.Key_name).length === 1);
            if (!unique) throw Error('PATIENT_CODE_UNIQUE_INDEX_REQUIRED');
            initialized = true;
        },
        async check() {
            if (!initialized) return false;
            // A timed-out query stays single-flight until the pool settles it.
            // Repeated probes cannot create an unbounded queue of connections.
            if (!pending) {
                pending = Promise.resolve().then(() => db.query('SELECT 1')).then(() => true, () => false)
                    .finally(() => { pending = null; });
            }
            let timer;
            try { return await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
            finally { clearTimeout(timer); }
        }
    };
}
module.exports = { createReadiness };

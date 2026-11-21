'use strict';
const { QueryTypes } = require('sequelize');
function createReadiness(db, timeoutMs = 2000) {
    let initialized = false;
    let pending = null;
    return {
        isInitialized() { return initialized; },
        async initialize() {
            initialized = false;
            await db.sync({ force: false });
            const rows = await db.query('SELECT next_value FROM patient_code_counter WHERE singleton = 1', { type: QueryTypes.SELECT });
            if (!rows.length || Number(rows[0].next_value) < 1 || Number(rows[0].next_value) > 99999999) throw Error('PATIENT_CODE_MIGRATION_REQUIRED');
            const indexes = await db.query('SHOW INDEX FROM person', { type: QueryTypes.SELECT });
            const unique = indexes.filter(row => Number(row.Non_unique) === 0 && row.Column_name === 'code')
                .some(row => indexes.filter(other => other.Key_name === row.Key_name).length === 1);
            if (!unique) throw Error('PATIENT_CODE_UNIQUE_INDEX_REQUIRED');
            if (process.env.PAYMENTS_CONNECTION) {
                const columns = await db.query('SHOW COLUMNS FROM business', { type: QueryTypes.SELECT });
                if (!['billing_snapshot','billing_revision','billing_access_until'].every(name => columns.some(column => column.Field === name)))
                    throw Error('PAYMENTS_LICENSE_MIGRATION_REQUIRED');
                const outbox = await db.query('SHOW COLUMNS FROM payments_welcome_outbox', { type: QueryTypes.SELECT });
                if (!['subscription_id','id_business','id_login','payment_id','payload','created_at','claimed_at','sent_at','error_code']
                    .every(name => outbox.some(column => column.Field === name)))
                    throw Error('PAYMENTS_WELCOME_MIGRATION_REQUIRED');
                const outboxIndexes = await db.query('SHOW INDEX FROM payments_welcome_outbox', { type: QueryTypes.SELECT });
                if (!outboxIndexes.some(index => index.Key_name === 'PRIMARY' && index.Column_name === 'subscription_id')
                    || outboxIndexes.filter(index => index.Key_name === 'PRIMARY').length !== 1)
                    throw Error('PAYMENTS_WELCOME_MIGRATION_REQUIRED');
            }
            const [notes] = await db.query(
                "SELECT COUNT(*) AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' AND TABLE_NAME IN ('evolution_note_draft','evolution_note_signed_version','evolution_note_performed_extra')",
                { type: QueryTypes.SELECT }
            );
            if (Number(notes?.present) !== 3) throw Error('NC5_NOTES_MIGRATION_REQUIRED');
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

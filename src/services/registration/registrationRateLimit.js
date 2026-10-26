'use strict';
const { QueryTypes } = require('sequelize');
const { mac } = require('./registrationSecurity');
const { RegistrationError } = require('./errors');
class RegistrationRateLimit {
    constructor(db) { this.db = db; this.nextCleanup = 0; }
    async cleanupExpired() {
        if (Date.now() < this.nextCleanup) return;
        this.nextCleanup = Date.now() + 60000;
        try {
            await this.db.query('DELETE FROM registration_rate_bucket WHERE expires_at < NOW(3) ORDER BY expires_at LIMIT 1000');
        } catch (_) { console.warn('[REGISTRATION_RATE_CLEANUP_FAILED]'); }
    }
    async consume(limits) {
        await this.cleanupExpired();
        const transaction = await this.db.transaction();
        try {
            // Stable order avoids deadlocks when IP, actor and destination overlap.
            const entries = limits.map(([scope, value, max, seconds]) => ({key:mac('rate-v1',scope+':'+value),max,seconds})).sort((a,b)=>a.key.localeCompare(b.key));
            for (const entry of entries) {
                const options = {transaction,replacements:entry};
                await this.db.query(`INSERT INTO registration_rate_bucket(bucket_key,hits,expires_at)
                    VALUES (:key,0,DATE_ADD(NOW(3),INTERVAL :seconds SECOND))
                    ON DUPLICATE KEY UPDATE bucket_key=registration_rate_bucket.bucket_key`,options);
                const [row] = await this.db.query(`SELECT hits,expires_at<=NOW(3) expired,
                    GREATEST(1,CEIL(TIMESTAMPDIFF(MICROSECOND,NOW(3),expires_at)/1000000)) retry
                    FROM registration_rate_bucket WHERE bucket_key=:key FOR UPDATE`,{...options,type:QueryTypes.SELECT});
                if (!row.expired && row.hits >= entry.max) {
                    const error = new RegistrationError('REGISTRATION_RATE_LIMITED',429); error.retryAfterSeconds=Number(row.retry); throw error;
                }
                await this.db.query(`UPDATE registration_rate_bucket SET hits=IF(expires_at<=NOW(3),1,hits+1),
                    expires_at=IF(expires_at<=NOW(3),DATE_ADD(NOW(3),INTERVAL :seconds SECOND),expires_at) WHERE bucket_key=:key`, options);
            }
            await transaction.commit();
        } catch (error) { if (!transaction.finished) await transaction.rollback(); throw error; }
    }
}
module.exports = { RegistrationRateLimit };

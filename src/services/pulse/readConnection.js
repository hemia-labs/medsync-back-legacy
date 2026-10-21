'use strict';
// A single reserved mysql2 connection. Sequelize readOnly alone does not emit READ ONLY.
async function consistentRead(db, work, { timeoutMs = 2000, metrics = {} } = {}) {
    const began = Date.now(), deadline = began + timeoutMs;
    let connection, uncertain = false, timer, expired = false, previousLimit;
    const acquiring = db.connectionManager.getConnection({ type: 'SELECT' });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(Object.assign(Error('PULSE_POOL_TIMEOUT'), { code: 'PULSE_POOL_TIMEOUT' })); }, timeoutMs); });
    acquiring.then(c => { if (expired) db.connectionManager.releaseConnection(c); }, () => { });
    try {
        connection = await Promise.race([acquiring, timeout]); clearTimeout(timer); metrics.poolWaitMs = Date.now() - began; metrics.queries = 0;
        const query = (sql, values = {}) => new Promise((resolve, reject) => {
            const remaining = deadline - Date.now(); if (remaining <= 0) { uncertain = true; reject(Object.assign(Error('PULSE_READ_TIMEOUT'), { code: 'PULSE_READ_TIMEOUT' })); return; }
            metrics.queries++;
            connection.query({ sql, namedPlaceholders: true, timeout: remaining }, values, (error, rows) => { if (error) { if (error.fatal || ['PROTOCOL_SEQUENCE_TIMEOUT', 'ER_LOCK_DEADLOCK', 'PULSE_READ_TIMEOUT'].includes(error.code)) uncertain = true; reject(error); } else resolve(rows); });
        });
        await query(`SET @pulse_previous_max_time=@@SESSION.max_execution_time, SESSION max_execution_time=${Math.max(1, deadline - Date.now() - 50)}`); previousLimit = true;
        await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        const result = await work(query, { deadline, metrics });
        await query('COMMIT'); return result;
    } catch (error) {
        if (connection && !uncertain) { try { await new Promise((resolve, reject) => connection.query({ sql: 'ROLLBACK', timeout: 500 }, err => err ? reject(err) : resolve())); } catch (_) { uncertain = true; } }
        throw error;
    } finally {
        clearTimeout(timer); metrics.elapsedMs = Date.now() - began;
        if (connection) {
            if (!uncertain && previousLimit) { try { await new Promise((resolve,reject) => connection.query({ sql: 'SET SESSION max_execution_time=@pulse_previous_max_time, @pulse_previous_max_time=NULL', timeout: 200 }, error => error ? reject(error) : resolve())); } catch (_) { uncertain = true; } }
            if (uncertain) { connection.destroy(); await db.connectionManager.destroyConnection(connection); } else await db.connectionManager.releaseConnection(connection);
        }
    }
}
module.exports = { consistentRead };

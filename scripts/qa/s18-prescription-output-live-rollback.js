// Existing synthetic QA recipes only. Audit writes stay in an outer transaction.
'use strict';
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { injectReplacements } = require('sequelize/lib/utils/sql');
const config = require('../../src/config/config');
const dialect = { name: 'mysql', TICK_CHAR_LEFT: '`', TICK_CHAR_RIGHT: '`', canBackslashEscape: () => true, supports: {} };
(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    let serial = 0;
    const db = {
        async transaction() {
            const name = `s18_rx_${++serial}`;
            await connection.query(`SAVEPOINT ${name}`);
            return { commit: () => connection.query(`RELEASE SAVEPOINT ${name}`), rollback: async () => { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); } };
        },
        async query(sql, options = {}) {
            assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|\bCALL\b/i);
            const [rows] = await connection.query(injectReplacements(sql, dialect, options.replacements));
            return rows;
        }
    };
    const id = require.resolve('../../src/db/Sequelize.connection');
    require.cache[id] = { id, filename: id, loaded: true, exports: db };
    const dao = require('../../src/Dao/mysql/prescription.dao');
    const actor = { id_business: 'QA_BUSINESS_CLINICAL', id_login: 'QA_LOGIN_CLINICAL' };
    const cases = [['QAC_RX_017', 'draft'], ['QAC_RX_019', 'cancelled'], ['QAC_RX_008', 'issued']];
    try {
        await connection.beginTransaction();
        const [before] = await connection.query('SELECT id_prescription,status FROM prescription WHERE id_business=? AND id_prescription IN (?) ORDER BY id_prescription', [actor.id_business, cases.map(row => row[0])]);
        for (const [recipe, expected] of cases) {
            assert.equal(before.find(row => row.id_prescription === recipe)?.status, expected, 'Expected existing synthetic fixture state');
            for (const action of ['printed', 'downloaded', 'pdf_generated']) {
                const result = await dao.prepareOutput({ ...actor, id_prescription: recipe, action, metadata: { source: 'qa_s18_rollback' } });
                assert.equal(result.status, expected === 'issued' ? 200 : 400, result.message);
                if (expected === 'issued') assert.equal(result.data.prescription.status, 'issued');
                else assert.equal(result.data.prescription, undefined);
            }
        }
        const [after] = await connection.query('SELECT id_prescription,status FROM prescription WHERE id_business=? AND id_prescription IN (?) ORDER BY id_prescription', [actor.id_business, cases.map(row => row[0])]);
        assert.deepEqual(after, before);
        await connection.rollback();
        const [audits] = await connection.query("SELECT COUNT(*) n FROM prescription_audit_log WHERE id_business=? AND metadata LIKE '%qa_s18_rollback%'", [actor.id_business]);
        assert.equal(Number(audits[0].n), 0, 'No test audit remains');
        console.log('PASS S18 prescription output: draft/cancelled denied for print/download/PDF, issued allowed; real DAO+SQL. One connection; audits rolled back, no clinical changes or physical outputs.');
    } finally { await connection.rollback(); await connection.end(); }
})().catch(error => { console.error('S18 prescription QA:', error.code || error.message); process.exitCode = 1; });

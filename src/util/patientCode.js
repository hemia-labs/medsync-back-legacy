'use strict';
const { QueryTypes } = require('sequelize');

// Global numbering preserves the existing visible scope. All allocation and
// patient writes use the same transaction/connection; a rollback releases both.
async function nextPatientCode(db, transaction) {
    const rows = await db.query('SELECT next_value FROM patient_code_counter WHERE singleton = 1 FOR UPDATE', {
        type: QueryTypes.SELECT, transaction
    });
    const next = Number(rows[0] && rows[0].next_value);
    if (!Number.isSafeInteger(next) || next < 1 || next > 99999999) throw new Error('PATIENT_CODE_SEQUENCE_UNAVAILABLE');
    await db.query('UPDATE patient_code_counter SET next_value = next_value + 1 WHERE singleton = 1', { transaction });
    return String(next).padStart(6, '0');
}
module.exports = { nextPatientCode };

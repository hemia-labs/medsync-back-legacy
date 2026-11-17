'use strict';
// NC1 identidad simple — users: first_surname / second_surname live in `login` only after the
// nc1-login-surnames migration. Code reads and writes them only when both columns exist, so deploying the
// application before the migration keeps every user flow working (surnames are then kept only as `last_name`).
const { QueryTypes } = require('sequelize');

let cache = null;
async function hasLoginSurnames(db, transaction = null) {
    if (cache && (cache.value || Date.now() - cache.at < 60000)) return cache.value;
    let value = false;
    try {
        const rows = await db.query("SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='login' AND COLUMN_NAME IN ('first_surname','second_surname')",
            { type: QueryTypes.SELECT, transaction });
        value = Number(rows && rows[0] && rows[0].total) === 2;
    } catch (_) { value = false; }
    cache = { value, at: Date.now() };
    return value;
}
function resetLoginSurnamesCache() { cache = null; }

// Writes the structured surnames of an account inside the caller's transaction (no-op before the migration).
async function writeLoginSurnames(db, idLogin, names, transaction) {
    if (!names || !idLogin || !(await hasLoginSurnames(db, transaction))) return false;
    await db.query('UPDATE login SET first_surname=:first, second_surname=:second WHERE id_login=:id',
        { replacements: { first: names.first_surname ?? null, second: names.second_surname ?? null, id: idLogin }, transaction });
    return true;
}

// Adds first_surname / second_surname (null when unknown or before the migration) to rows with id_login.
async function withLoginSurnames(db, rows, transaction = null) {
    const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
    const blank = row => ({ ...row, first_surname: null, second_surname: null });
    let result = list.map(blank);
    const ids = list.map(row => row.id_login).filter(Boolean);
    if (ids.length && await hasLoginSurnames(db, transaction)) {
        const found = await db.query('SELECT id_login, first_surname, second_surname FROM login WHERE id_login IN (:ids)', { replacements: { ids }, type: QueryTypes.SELECT, transaction });
        const byId = new Map((found || []).map(row => [row.id_login, row]));
        result = list.map(row => ({ ...row, first_surname: byId.get(row.id_login)?.first_surname ?? null, second_surname: byId.get(row.id_login)?.second_surname ?? null }));
    }
    return Array.isArray(rows) ? result : (result[0] || rows);
}
module.exports = { hasLoginSurnames, resetLoginSurnamesCache, writeLoginSurnames, withLoginSurnames };

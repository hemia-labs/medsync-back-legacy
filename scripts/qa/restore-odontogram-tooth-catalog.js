'use strict';

// Add missing standard catalog rows only. No schema, patient, or clinical-row
// replacements. Caller passes its existing MySQL connection (CO15 uses ONE).
// Primary references, reviewed 2026-10-16:
// https://www.iso.org/standard/68292.html (ISO 3950:2016, two-digit FDI system)
// https://dicom.nema.org/medical/dicom/current/output/chtml/part16/sect_CID_4018.html
// https://dicom.nema.org/medical/dicom/current/output/chtml/part16/sect_CID_4019.html
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { v5: uuid } = require('uuid');
const { createHash } = require('node:crypto');

const columns = ['id_tooth', 'description', 'sec', 'order', 'id_cat_x_position_tooth', 'id_cat_y_position_tooth', 'id_cat_type_tooth', 'id_cat_order_tooth'];

module.exports = async function restoreToothCatalog(connection, { apply = false } = {}) {
    const query = async (sql, replacements) => (await connection.query(sql, replacements))[0];
    const catalogs = {};
    for (const table of ['cat_type_tooth', 'cat_x_position_tooth', 'cat_y_position_tooth', 'cat_order_tooth']) {
        catalogs[table] = await query(`SELECT * FROM ${table}`);
    }
    function one(table, field, value, id) {
        const rows = catalogs[table].filter(row => row[field] === value);
        assert.equal(rows.length, 1, `Exactly one installed ${table}.${field}=${value}`);
        return rows[0][id];
    }
    const right = one('cat_x_position_tooth', 'description', 'Derecha', 'id_cat_x_position_tooth');
    const left = one('cat_x_position_tooth', 'description', 'Izquierda', 'id_cat_x_position_tooth');
    const top = one('cat_y_position_tooth', 'code', 'ECCBC8', 'id_cat_y_position_tooth');
    const bottom = one('cat_y_position_tooth', 'code', 'A87FF6', 'id_cat_y_position_tooth');
    const expected = [];
    for (const [code, firstQuadrant, maxPosition] of [['C4CA42', 1, 8], ['CFCD20', 5, 5]]) {
        const type = one('cat_type_tooth', 'code', code, 'id_cat_type_tooth');
        for (let quadrant = firstQuadrant; quadrant < firstQuadrant + 4; quadrant++) {
            const anatomical = quadrant > 4 ? quadrant - 4 : quadrant;
            // Legacy 2x2 display is upper-right, upper-left, lower-right,
            // lower-left (src/jsonFiles/Dientes.json). FDI anatomy is unchanged.
            const display = { 1: 1, 2: 2, 3: 4, 4: 3 }[anatomical];
            const ordering = one('cat_order_tooth', 'sec', display, 'id_cat_order_tooth');
            for (let position = 1; position <= maxPosition; position++) {
                const number = quadrant * 10 + position;
                expected.push({
                    id_tooth: uuid(`https://medsync.local/catalog/tooth/fdi/${number}`, uuid.URL),
                    description: `Pieza dental ${number}`,
                    sec: number,
                    order: [1, 4].includes(anatomical) ? maxPosition + 1 - position : position,
                    id_cat_x_position_tooth: [1, 4].includes(anatomical) ? right : left,
                    id_cat_y_position_tooth: anatomical <= 2 ? top : bottom,
                    id_cat_type_tooth: type,
                    id_cat_order_tooth: ordering
                });
            }
        }
    }
    assert.equal(expected.length, 52);
    assert.equal(new Set(expected.map(row => row.id_tooth)).size, 52);
    assert.equal(new Set(expected.map(row => row.sec)).size, 52);

    await connection.beginTransaction();
    try {
        const before = await query('SELECT * FROM cat_tooth ORDER BY sec,id_tooth FOR UPDATE');
        const missing = [];
        for (const row of expected) {
            const existing = before.filter(value => value.id_tooth === row.id_tooth || Number(value.sec) === row.sec);
            assert.ok(existing.length <= 1, `Ambiguous existing catalog for FDI ${row.sec}`);
            if (existing.length) {
                for (const column of columns) assert.equal(existing[0][column], row[column], `Existing FDI ${row.sec}.${column} conflicts; no overwrite allowed`);
            } else missing.push(row);
        }
        if (!missing.length) {
            await connection.rollback();
            console.log('PASS CO15 catalog: 52 standard FDI rows already match; nothing changed.');
            return { inserted: 0, total: before.length };
        }
        // Unknown historical tooth ids need recovery, not a synthetic remap.
        for (const table of ['odontogram', 'odontogramDetailv1']) {
            const rows = await query(`SELECT COUNT(*) n FROM ${table} detail LEFT JOIN cat_tooth tooth ON tooth.id_tooth=detail.id_tooth WHERE tooth.id_tooth IS NULL`);
            assert.equal(Number(rows[0].n), 0, `Cannot reconstruct ${table} tooth identities while historical references are orphaned`);
        }
        if (!apply) {
            await connection.rollback();
            console.log(`CO15 catalog dry run: ${before.length} existing; ${missing.length} missing standard FDI rows; no writes.`);
            return { inserted: 0, missing: missing.length, total: before.length };
        }
        const definition = (await query('SHOW CREATE TABLE cat_tooth'))[0]['Create Table'];
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = path.resolve(__dirname, '../../../_schema_backups', `co15_tooth_catalog_${stamp}`);
        await fs.mkdir(backup, { recursive: false });
        const snapshot = JSON.stringify({ captured_at: new Date().toISOString(), table: 'cat_tooth', rows: before, definition, parent_catalogs: catalogs }, null, 2) + '\n';
        await fs.writeFile(path.join(backup, 'before.json'), snapshot, { flag: 'wx' });
        await fs.writeFile(path.join(backup, 'before.sha256'), createHash('sha256').update(snapshot).digest('hex') + '\n', { flag: 'wx' });
        for (const row of missing) {
            await query('INSERT INTO cat_tooth (`' + columns.join('`,`') + '`) VALUES (' + columns.map(() => '?').join(',') + ')', columns.map(column => row[column]));
        }
        const after = await query('SELECT * FROM cat_tooth ORDER BY sec,id_tooth');
        assert.equal(after.length, before.length + missing.length);
        for (const row of expected) {
            const inserted = after.find(value => value.id_tooth === row.id_tooth);
            assert.ok(inserted, `FDI ${row.sec} exists`);
            for (const column of columns) assert.equal(inserted[column], row[column], `FDI ${row.sec}.${column} verified`);
        }
        await connection.commit();
        console.log(`PASS CO15 catalog: inserted ${missing.length} standard FDI rows (32 permanent/20 temporary), no updates/deletes; before snapshot ${backup}.`);
        return { inserted: missing.length, total: after.length, backup };
    } catch (error) {
        await connection.rollback();
        throw error;
    }
};

if (require.main === module) {
    require('../../src/config/env');
    const config = require('../../src/config/config');
    const security = require('../../src/config/security');
    const mysql = require('mysql2/promise');
    (async () => {
        assert.equal(security.isProductionLike(), false, 'Cannot seed in a production-like runtime');
        const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
        try { await module.exports(connection, { apply: process.argv.includes('--apply') }); }
        finally { await connection.end(); }
    })().catch(error => { console.error('CO15 catalog:', error.code || error.message); process.exitCode = 1; });
}

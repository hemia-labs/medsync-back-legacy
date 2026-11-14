'use strict';
// NC4/L2: QA del DDL de catálogos contra un MySQL aislado. Lo invoca scripts/qa/nc4-catalogs.docker.sh.
// Se niega a correr sin NC4_QA_ISOLATED=1: nunca debe apuntar a una base real.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const migration = require('../migrations/nc4-catalogs');
const { buildRelease } = require('../../src/domain/sisCatalog/release');

if (process.env.NC4_QA_ISOLATED !== '1' || !process.env.NC4_QA_PORT) {
    console.error('Solo en MySQL aislado: defina NC4_QA_ISOLATED=1 y NC4_QA_PORT (use nc4-catalogs.docker.sh).');
    process.exit(2);
}

const results = [];
async function step(name, fn) {
    try { await fn(); results.push(['PASS', name]); }
    catch (e) { results.push(['FAIL', name, e.message]); }
}
async function rejects(conn, sql, params, pattern) {
    try { await conn.query(sql, params); } catch (e) {
        if (pattern && !pattern.test(e.message)) throw new Error(`Rechazo inesperado: ${e.message}`);
        return e.message;
    }
    throw new Error('Se esperaba un rechazo y la sentencia se aplicó: ' + sql);
}

const manifest = (over = {}) => ({
    releaseId: 'qa-entity-1', family: 'sis.federal_entity', sourceCatalogName: 'ENTIDAD FEDERATIVA', sourceUrl: null, sourceVersion: null,
    downloadedAt: '2026-11-13T00:00:00.000Z', sha256: 'a'.repeat(64), encoding: 'xlsx/utf-8', validFrom: '2026-01-01', validTo: null,
    validityBasis: 'publication_label', provenance: 'official', status: 'staged', verifiedAt: null, columnMapping: { sheet: 0 }, ...over
});

async function insertRelease(conn, release, { entries = true, relations = true } = {}) {
    const m = release.manifest;
    await conn.query(`INSERT INTO sis_catalog_release (release_id, family, source_catalog_name, source_url, source_version, downloaded_at, sha256,
        content_sha256, encoding, valid_from, valid_to, validity_basis, provenance, status, verified_at, column_mapping_json, entry_count, relation_count)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [m.releaseId, m.family, m.sourceCatalogName, m.sourceUrl, m.sourceVersion, m.downloadedAt.replace('T', ' ').replace('Z', ''), m.sha256,
        release.contentSha256, m.encoding, m.validFrom, m.validTo, m.validityBasis, m.provenance, m.status, m.verifiedAt,
        JSON.stringify(m.columnMapping), release.entryCount, release.relationCount]);
    if (entries) for (const e of release.list()) {
        await conn.query('INSERT INTO sis_catalog_entry (family, release_id, code, label, attributes_json, is_sentinel) VALUES (?,?,?,?,?,?)',
            [m.family, m.releaseId, e.code, e.label, JSON.stringify(e.attributes), e.sentinel ? 1 : 0]);
    }
    if (relations) for (const p of release.pairs()) {
        await conn.query('INSERT INTO sis_catalog_relation (family, release_id, left_family, left_code, right_code) VALUES (?,?,?,?,?)',
            [m.family, m.releaseId, m.columnMapping.relationLeftFamily, p.left, p.right]);
    }
}

async function main() {
    const base = { host: '127.0.0.1', port: Number(process.env.NC4_QA_PORT), user: 'root', password: 'isolated-test-only' };
    const conn = await mysql.createConnection({ ...base, database: 'medsync_nc4_test' });
    const [[{ v }]] = await conn.query('SELECT VERSION() AS v');
    console.log(`MySQL ${v} (${process.env.NC4_QA_IMAGE || 'imagen sin declarar'})`);
    const verified = "UPDATE sis_catalog_release SET status='verified', verified_at='2026-11-13 12:00:00.000' WHERE release_id=?";

    await step('install crea tablas y triggers', () => migration.install(conn));
    await step('install es reanudable (segunda ejecución sin cambios)', () => migration.install(conn));
    await step('columnas CatalogRef ascii_bin con longitudes 48/50/32', async () => {
        const [cols] = await conn.query(`SELECT TABLE_NAME t, COLUMN_NAME c, CHARACTER_MAXIMUM_LENGTH l, COLLATION_NAME k FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sis_catalog_entry' AND COLUMN_NAME IN ('family','release_id','code') ORDER BY ORDINAL_POSITION`);
        assert.deepEqual(cols.map(r => [r.c, Number(r.l), r.k]), [['family', 48, 'ascii_bin'], ['release_id', 50, 'ascii_bin'], ['code', 32, 'ascii_bin']]);
    });

    const entity = buildRelease(manifest(), [{ code: '01', label: 'AGUASCALIENTES' }, { code: '1', label: 'distinto de 01' }, { code: '88', label: 'NO APLICA' }]);
    await step('carga staged con códigos 01 y 1 distintos', async () => {
        await insertRelease(conn, entity);
        const [rows] = await conn.query("SELECT code FROM sis_catalog_entry WHERE release_id='qa-entity-1' ORDER BY code");
        assert.deepEqual(rows.map(r => r.code), ['01', '1', '88']);
    });
    await step('release nace staged: insertar verified directo se rechaza', () =>
        rejects(conn, `INSERT INTO sis_catalog_release (release_id, family, source_catalog_name, downloaded_at, sha256, content_sha256, encoding, valid_from,
            validity_basis, provenance, status, verified_at, column_mapping_json, entry_count, relation_count)
            VALUES ('qa-direct','sis.federal_entity','X','2026-11-13','${'b'.repeat(64)}','${'c'.repeat(64)}','x','2026-01-01','official','official','verified','2026-11-13','{}',0,0)`, [], /staged/));
    await step('CHECK: familia en mayúsculas y código con espacio se rechazan', async () => {
        await rejects(conn, `INSERT INTO sis_catalog_release (release_id, family, source_catalog_name, downloaded_at, sha256, content_sha256, encoding,
            validity_basis, provenance, status, column_mapping_json, entry_count, relation_count)
            VALUES ('qa-bad','SIS.Entity','X','2026-11-13','${'d'.repeat(64)}','${'e'.repeat(64)}','x','unknown','official','staged','{}',0,0)`, [], /chk_sis_release_family/);
        await rejects(conn, "INSERT INTO sis_catalog_entry (family, release_id, code, label, attributes_json) VALUES ('sis.federal_entity','qa-entity-1','0 1','x','{}')", [], /chk_sis_entry_code/);
    });

    const partial = buildRelease(manifest({ releaseId: 'qa-entity-partial', sha256: 'f'.repeat(64) }), [{ code: '02', label: 'B' }, { code: '03', label: 'C' }]);
    await step('verificar con conteos incompletos se rechaza', async () => {
        await insertRelease(conn, partial, { entries: false });
        await conn.query("INSERT INTO sis_catalog_entry (family, release_id, code, label, attributes_json) VALUES ('sis.federal_entity','qa-entity-partial','02','B','{}')");
        await rejects(conn, verified, ['qa-entity-partial'], /conteos/);
        const [[r]] = await conn.query("SELECT status, verified_at FROM sis_catalog_release WHERE release_id='qa-entity-partial'");
        assert.deepEqual([r.status, r.verified_at], ['staged', null]);
    });
    await step('descartar staged → retired sin verified_at; con verified_at se rechaza', async () => {
        await rejects(conn, "UPDATE sis_catalog_release SET status='retired', verified_at='2026-11-13' WHERE release_id='qa-entity-partial'", [], /verified_at/);
        await conn.query("UPDATE sis_catalog_release SET status='retired' WHERE release_id='qa-entity-partial'");
    });
    // L2-R7: reproducción de Codex. Un release descartado con entry_count=5 y cero entradas no puede recibir verified_at.
    const forged = buildRelease(manifest({ releaseId: 'qa-forged', sha256: '9'.repeat(64) }), ['11', '12', '13', '14', '15'].map(code => ({ code, label: code })));
    await step('L2-R7: un descartado no puede fabricar verified_at por ninguna vía', async () => {
        await insertRelease(conn, forged, { entries: false });
        await conn.query("UPDATE sis_catalog_release SET status='retired' WHERE release_id='qa-forged'");
        await rejects(conn, "UPDATE sis_catalog_release SET verified_at='2026-11-13 12:00:00.000' WHERE release_id='qa-forged'", [], /verified_at/);
        await rejects(conn, "UPDATE sis_catalog_release SET status='retired', verified_at='2026-11-13 12:00:00.000' WHERE release_id='qa-forged'", [], /verified_at/);
        await rejects(conn, "UPDATE sis_catalog_release SET status='verified', verified_at='2026-11-13 12:00:00.000' WHERE release_id='qa-forged'", [], /Transicion/);
        const [[r]] = await conn.query("SELECT status, verified_at, entry_count FROM sis_catalog_release WHERE release_id='qa-forged'");
        assert.deepEqual([r.status, r.verified_at, Number(r.entry_count)], ['retired', null, 5]);
        const [[n]] = await conn.query("SELECT COUNT(*) n FROM sis_catalog_entry WHERE release_id='qa-forged'");
        assert.equal(Number(n.n), 0);
    });
    await step('verificar con conteos completos', () => conn.query(verified, ['qa-entity-1']));

    const mutations = [
        ['insertar entrada en release verificado', "INSERT INTO sis_catalog_entry (family, release_id, code, label, attributes_json) VALUES ('sis.federal_entity','qa-entity-1','02','X','{}')", /staged/],
        ['cambiar etiqueta de entrada', "UPDATE sis_catalog_entry SET label='X' WHERE release_id='qa-entity-1' AND code='01'", /inmutable/],
        ['borrar entrada', "DELETE FROM sis_catalog_entry WHERE release_id='qa-entity-1' AND code='01'", /inmutable/],
        ['cambiar source_url', "UPDATE sis_catalog_release SET source_url='https://otro' WHERE release_id='qa-entity-1'", /Solo cambia el estado/],
        ['cambiar source_version', "UPDATE sis_catalog_release SET source_version='v2' WHERE release_id='qa-entity-1'", /Solo cambia el estado/],
        ['cambiar source_catalog_name', "UPDATE sis_catalog_release SET source_catalog_name='OTRO' WHERE release_id='qa-entity-1'", /Solo cambia el estado/],
        ['cambiar encoding', "UPDATE sis_catalog_release SET encoding='latin1' WHERE release_id='qa-entity-1'", /Solo cambia el estado/],
        ['cambiar validity_basis', "UPDATE sis_catalog_release SET validity_basis='download_date' WHERE release_id='qa-entity-1'", /Solo cambia el estado/],
        ['cambiar column_mapping_json', "UPDATE sis_catalog_release SET column_mapping_json='{\"sheet\":1}' WHERE release_id='qa-entity-1'", /Solo cambia el estado/],
        ['cambiar content_sha256', `UPDATE sis_catalog_release SET content_sha256='${'0'.repeat(64)}' WHERE release_id='qa-entity-1'`, /Solo cambia el estado/],
        ['volver a staged', "UPDATE sis_catalog_release SET status='staged', verified_at=NULL WHERE release_id='qa-entity-1'", /Transicion|verified_at|chk_sis_release_state/],
        ['cambiar verified_at', "UPDATE sis_catalog_release SET verified_at='2027-01-01' WHERE release_id='qa-entity-1'", /verified_at/],
        ['borrar release', "DELETE FROM sis_catalog_release WHERE release_id='qa-entity-1'", /no se borra/]
    ];
    const snapshot = async () => JSON.stringify(await Promise.all([
        conn.query("SELECT * FROM sis_catalog_release WHERE release_id='qa-entity-1'").then(r => r[0]),
        conn.query("SELECT * FROM sis_catalog_entry WHERE release_id='qa-entity-1' ORDER BY code").then(r => r[0])
    ]));
    const before = await snapshot();
    for (const [name, sql, pattern] of mutations) await step(`rechaza: ${name}`, () => rejects(conn, sql, [], pattern));
    await step('tras los rechazos el release y sus entradas no cambiaron', async () => assert.equal(await snapshot(), before));

    const service = buildRelease(manifest({ releaseId: 'qa-sb-1', family: 'sis.personnel_service_sb', sourceCatalogName: 'SIS-SB', sha256: '1'.repeat(64),
        columnMapping: { sheet: 0, relationLeftFamily: 'sis.personnel_type' } }), [{ code: '10', label: 'ODONTOLOGÍA' }, { code: '12', label: 'ODONTOPEDIATRÍA' }],
    { relations: [{ left: '13', right: '10' }, { left: '14', right: '12' }] });
    await step('relaciones: carga staged, verificación y bloqueo posterior', async () => {
        await insertRelease(conn, service);
        await conn.query(verified, ['qa-sb-1']);
        await rejects(conn, "INSERT INTO sis_catalog_relation VALUES ('sis.personnel_service_sb','qa-sb-1','sis.personnel_type','13','12')", [], /staged/);
        await rejects(conn, "UPDATE sis_catalog_relation SET left_code='12' WHERE release_id='qa-sb-1'", [], /inmutable/);
        await rejects(conn, "DELETE FROM sis_catalog_relation WHERE release_id='qa-sb-1'", [], /inmutable/);
        const [rows] = await conn.query("SELECT left_code, right_code FROM sis_catalog_relation WHERE release_id='qa-sb-1' ORDER BY left_code");
        assert.deepEqual(rows.map(r => [r.left_code, r.right_code]), [['13', '10'], ['14', '12']]);
    });
    await step('verified → retired conserva verified_at y sigue resoluble', async () => {
        await conn.query("UPDATE sis_catalog_release SET status='retired' WHERE release_id='qa-sb-1'");
        const [[r]] = await conn.query("SELECT status, verified_at FROM sis_catalog_release WHERE release_id='qa-sb-1'");
        assert.equal(r.status, 'retired');
        assert.ok(r.verified_at);
        // L2-R7: tampoco se borra ni se cambia la evidencia de un retirado tras verificarse.
        await rejects(conn, "UPDATE sis_catalog_release SET verified_at=NULL WHERE release_id='qa-sb-1'", [], /verified_at/);
        await rejects(conn, "UPDATE sis_catalog_release SET verified_at='2030-01-01 00:00:00.000' WHERE release_id='qa-sb-1'", [], /verified_at/);
        const [[again]] = await conn.query("SELECT verified_at FROM sis_catalog_release WHERE release_id='qa-sb-1'");
        assert.deepEqual(again.verified_at, r.verified_at);
    });

    await step('FK de ejemplo NC1: válida, huérfana, mayúsculas, ceros, candidata y nulos parciales', async () => {
        await conn.query(`CREATE TABLE care_establishment (id VARCHAR(50) PRIMARY KEY, clues_family ${migration.REF.family} NULL,
            clues_release_id ${migration.REF.releaseId} NULL, clues_code ${migration.REF.code} NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        const clues = buildRelease(manifest({ releaseId: 'qa-clues-1', family: 'sis.establishments', sourceCatalogName: 'ESTABLECIMIENTO_DE_SALUD_SIS', sha256: '2'.repeat(64) }),
            [{ code: 'ASSSA000013', label: 'A', attributes: { en_operacion: '1' } }]);
        await insertRelease(conn, clues);
        await conn.query(verified, ['qa-clues-1']);
        await conn.query(migration.nc1ForeignKeyExample);
        const ins = (id, f, r, c) => conn.query('INSERT INTO care_establishment VALUES (?,?,?,?)', [id, f, r, c]);
        await ins('ok', 'sis.establishments', 'qa-clues-1', 'ASSSA000013');
        await rejects(conn, 'INSERT INTO care_establishment VALUES (?,?,?,?)', ['orphan', 'sis.establishments', 'qa-clues-1', 'ASSSA000014'], /foreign key/i);
        await rejects(conn, 'INSERT INTO care_establishment VALUES (?,?,?,?)', ['lower', 'sis.establishments', 'qa-clues-1', 'asssa000013'], /foreign key/i);
        await rejects(conn, 'INSERT INTO care_establishment VALUES (?,?,?,?)', ['family', 'sis.country', 'qa-clues-1', 'ASSSA000013'], /chk_care_establishment_clues_family|foreign key/i);
        await ins('candidate', 'sis.establishments', null, 'ASSSA000099');
        // MATCH SIMPLE: estos nulos parciales pasan la FK. El CHECK de forma de NC1 (Codex) debe rechazarlos.
        await ins('partial-family', null, 'qa-clues-1', 'ASSSA000013');
        await ins('partial-code', 'sis.establishments', 'qa-clues-1', null);
        const entityRel = 'qa-entity-1';
        await conn.query(`CREATE TABLE birth_ref (id INT PRIMARY KEY, f ${migration.REF.family}, r ${migration.REF.releaseId}, c ${migration.REF.code},
            FOREIGN KEY (f, r, c) REFERENCES sis_catalog_entry (family, release_id, code) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
        await conn.query('INSERT INTO birth_ref VALUES (1, ?, ?, ?)', ['sis.federal_entity', entityRel, '01']);
        await rejects(conn, 'INSERT INTO birth_ref VALUES (2, ?, ?, ?)', ['sis.federal_entity', entityRel, '001'], /foreign key/i);
    });
    await step('referencia a release retirado sigue íntegra (RESTRICT + inmutabilidad)', async () => {
        await conn.query("UPDATE sis_catalog_release SET status='retired' WHERE release_id='qa-clues-1'");
        const [[r]] = await conn.query("SELECT COUNT(*) n FROM care_establishment c JOIN sis_catalog_entry e ON e.family=c.clues_family AND e.release_id=c.clues_release_id AND e.code=c.clues_code");
        assert.equal(Number(r.n), 1);
        await rejects(conn, "DELETE FROM sis_catalog_entry WHERE release_id='qa-clues-1'", [], /inmutable/);
    });

    await step('install aborta ante una tabla existente incompatible', async () => {
        await conn.query('CREATE DATABASE medsync_nc4_incompatible');
        const other = await mysql.createConnection({ ...base, database: 'medsync_nc4_incompatible' });
        try {
            await other.query(migration.tables[0][1]);
            await other.query(migration.tables[1][1].replace(`code ${migration.REF.code}`, 'code VARCHAR(32) COLLATE utf8mb4_unicode_ci'));
            await assert.rejects(migration.install(other), { code: 'CATALOG_DDL_INCOMPATIBLE' });
            const [t] = await other.query("SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='medsync_nc4_incompatible'");
            assert.equal(Number(t[0].n), 0);
        } finally { await other.end(); }
    });
    // L2-R8: cada alteración se aplica sobre una instalación limpia y registrada; install() debe abortar sin reparar.
    let driftIndex = 0;
    async function drift(name, alterations, { after } = {}) {
        await step(`L2-R8: install aborta tras ${name}`, async () => {
            const db = `medsync_nc4_drift_${++driftIndex}`;
            await conn.query(`CREATE DATABASE ${db}`);
            const other = await mysql.createConnection({ ...base, database: db });
            try {
                await migration.install(other);
                for (const sql of alterations) await other.query(sql);
                const before = JSON.stringify(await migration.describeTable(other, 'sis_catalog_entry'));
                await assert.rejects(migration.install(other), { code: 'CATALOG_DDL_INCOMPATIBLE' });
                assert.equal(JSON.stringify(await migration.describeTable(other, 'sis_catalog_entry')), before, 'install no debe reparar');
                if (after) await after(other);
            } finally { await other.end(); }
        });
    }
    await drift('DROP CHECK chk_sis_entry_code (reproducción de Codex)', ['ALTER TABLE sis_catalog_entry DROP CHECK chk_sis_entry_code'], {
        // Sin el CHECK la DB acepta un código con espacio: por eso el instalador debe detectarlo.
        after: async other => {
            await other.query("INSERT INTO sis_catalog_release (release_id, family, source_catalog_name, downloaded_at, sha256, content_sha256, encoding, validity_basis, provenance, status, column_mapping_json, entry_count, relation_count) VALUES ('d1','sis.federal_entity','X','2026-11-13','" + 'a'.repeat(64) + "','" + 'b'.repeat(64) + "','x','unknown','official','staged','{}',1,0)");
            await other.query("INSERT INTO sis_catalog_entry (family, release_id, code, label, attributes_json) VALUES ('sis.federal_entity','d1','with space','x','{}')");
        }
    });
    await drift('CHECK no forzado', ['ALTER TABLE sis_catalog_release ALTER CHECK chk_sis_release_status NOT ENFORCED']);
    await drift('CHECK con otra cláusula y el mismo nombre', ['ALTER TABLE sis_catalog_entry DROP CHECK chk_sis_entry_code', "ALTER TABLE sis_catalog_entry ADD CONSTRAINT chk_sis_entry_code CHECK (code <> '')"]);
    await drift('FK eliminada', ['ALTER TABLE sis_catalog_entry DROP FOREIGN KEY fk_sis_entry_release']);
    await drift('FK con otra regla', ['ALTER TABLE sis_catalog_entry DROP FOREIGN KEY fk_sis_entry_release',
        'ALTER TABLE sis_catalog_entry ADD CONSTRAINT fk_sis_entry_release FOREIGN KEY (family, release_id) REFERENCES sis_catalog_release (family, release_id) ON DELETE CASCADE ON UPDATE RESTRICT']);
    await drift('tipo de columna no referencial', ['ALTER TABLE sis_catalog_entry MODIFY label VARCHAR(400) COLLATE utf8mb4_unicode_ci NOT NULL']);
    await drift('nulabilidad', ['ALTER TABLE sis_catalog_release MODIFY source_url VARCHAR(1000) COLLATE utf8mb4_unicode_ci NOT NULL']);
    await drift('índice eliminado', ['ALTER TABLE sis_catalog_release DROP INDEX idx_sis_release_lookup']);
    await drift('trigger reemplazado', ['DROP TRIGGER trg_sis_release_delete', 'CREATE TRIGGER trg_sis_release_delete BEFORE DELETE ON sis_catalog_release FOR EACH ROW SET @x = 1']);
    await step('L2-R8: registro sin tabla aborta', async () => {
        await conn.query('CREATE DATABASE medsync_nc4_missing');
        const other = await mysql.createConnection({ ...base, database: 'medsync_nc4_missing' });
        try {
            await migration.install(other);
            await other.query('SET FOREIGN_KEY_CHECKS=0');
            await other.query('DROP TABLE sis_catalog_relation');
            await assert.rejects(migration.install(other), { code: 'CATALOG_DDL_INCOMPATIBLE' });
        } finally { await other.end(); }
    });

    await conn.end();
    for (const [status, name, detail] of results) console.log(`${status} ${name}${detail ? ' — ' + detail : ''}`);
    const failed = results.filter(r => r[0] === 'FAIL').length;
    console.log(`# total ${results.length} pass ${results.length - failed} fail ${failed}`);
    process.exitCode = failed ? 1 : 0;
}

main().catch(e => { console.error('ERROR', e.message); process.exitCode = 1; });

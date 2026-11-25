'use strict';
// Run with bash scripts/qa/nc4-catalogs.docker.sh mysql:8.4 clues-sync.
// The injected workbook and the database are both disposable; no network source or .env is used.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const mysql = require('mysql2/promise');
const { xlsx } = require('./fixtures/nc4-xlsx');
const { install } = require('../migrations/nc4-catalogs');
const { importXlsxRelease } = require('../../src/domain/sisCatalog/importer');
const { installRelease } = require('../../src/domain/sisCatalog/installRelease');
const { syncClues } = require('../../src/jobs/syncClues');

const family = 'sis.establishments';
const code = 'QATEST00001';
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const headers = [
    'clues', 'nombre_unidad', 'en_operacion', 'tipo_unidad', 'tip_abreviacion',
    'sub_abreviacion', 'institucion', 'id_entidad_federativa'
];

function source(sourceVersion, labels) {
    const rows = labels.map((label, i) => [
        'QATEST' + String(i + 1).padStart(5, '0'), label, '1', '1', 'CONS', 'A', 'QA', '09'
    ]);
    const buffer = xlsx([{ name: 'ESTABLECIMIENTOS', rows: [headers, ...rows] }]);
    const sourceUrl = 'https://gobi.salud.gob.mx/gobi/guias/sis/catalogos/ESTABLECIMIENTO_DE_SALUD_SIS_' + sourceVersion + '.xlsx';
    return { buffer, sourceUrl, sourceVersion };
}

async function main() {
    assert.equal(process.env.NC4_QA_ISOLATED, '1', 'Use the disposable NC4 Docker runner');
    assert.match(process.env.NC4_QA_PORT || '', /^\d+$/);
    const options = {
        host: '127.0.0.1', port: Number(process.env.NC4_QA_PORT), database: 'medsync_nc4_test',
        user: 'root', password: 'isolated-test-only', timezone: 'Z'
    };
    const conn = await mysql.createConnection(options);
    let other;
    try {
        other = await mysql.createConnection(options);
        await install(conn, () => {});
        const run = (connection, catalog, date) => syncClues(connection, {
            getSource: async () => catalog, now: new Date(date + 'T23:00:00.000Z')
        });
        const releases = async () => {
            const [rows] = await conn.query(
                'SELECT release_id, sha256, source_url, source_version, entry_count, status FROM sis_catalog_release WHERE family=? ORDER BY valid_from',
                [family]
            );
            return rows;
        };

        // A workbook with two valid rows is too small for a first national catalog.
        const previous = source('202609', ['Nombre previo', 'Segunda unidad']);
        await assert.rejects(run(conn, previous, '2026-11-16'), { code: 'CLUES_COUNT_DROP_REVIEW' });
        assert.deepEqual(await releases(), []);
        console.log('PASS Partial initial publication leaves the database empty');

        // The first shared release was installed by the NC1 CLI, with a date-based identifier.
        const previousId = 'sis.establishments-20261117';
        const { release } = importXlsxRelease(previous.buffer, {
            family, releaseId: previousId, sourceUrl: previous.sourceUrl, sourceVersion: 'ESTABLECIMIENTO_DE_SALUD_SIS_202609.xlsx',
            downloadedAt: '2026-11-17T12:00:00.000Z', validFrom: '2026-11-17', validTo: '2026-11-27',
            validityBasis: 'download_date', provenance: 'official'
        });
        await installRelease(conn, release, { verify: true, sourceSha256: sha256(previous.buffer) });
        const initial = await run(conn, previous, '2026-11-21');
        assert.equal(initial.status, 'unchanged');
        assert.equal(initial.releaseId, previousId);
        const beforeExpiration = await releases();
        assert.equal(beforeExpiration.length, 1);
        await assert.rejects(run(conn, previous, '2026-11-27'), { code: 'CLUES_HISTORICAL_OR_UNVERIFIED_FILE' });
        assert.deepEqual(await releases(), beforeExpiration);
        console.log('PASS Existing NC1 release reused by source hash only inside its effective window');

        const current = source('202611', ['Nombre vigente', 'Segunda unidad']);
        const results = await Promise.all([
            run(conn, current, '2026-11-28'), run(other, current, '2026-11-28')
        ]);
        assert.deepEqual(results.map(r => r.status).sort(), ['installed', 'unchanged']);
        const currentId = results[0].releaseId;
        assert.equal(results[1].releaseId, currentId);
        assert.notEqual(previousId, currentId);
        const installed = await releases();
        assert.equal(installed.length, 2);
        assert.deepEqual(installed[1], {
            release_id: currentId, sha256: sha256(current.buffer), source_url: current.sourceUrl,
            source_version: current.sourceVersion, entry_count: 2, status: 'verified'
        });
        const retry = await run(conn, current, '2026-12-05');
        assert.equal(retry.status, 'unchanged');
        assert.equal(retry.releaseId, currentId);
        assert.deepEqual(await releases(), installed);
        const [entries] = await conn.query(
            'SELECT release_id, label FROM sis_catalog_entry WHERE family=? AND code=?',
            [family, code]
        );
        const byRelease = new Map(entries.map(row => [row.release_id, row.label]));
        assert.equal(byRelease.get(previousId), 'Nombre previo');
        assert.equal(byRelease.get(currentId), 'Nombre vigente');
        console.log('PASS Concurrent import, weekly retry and historical reference');

        await assert.rejects(run(conn, { ...current, buffer: Buffer.from('HTML instead of an XLSX') }, '2026-12-12'), { code: 'XLSX_INVALID' });
        const truncated = source('202612', ['Sólo quedó la primera']);
        await assert.rejects(run(conn, truncated, '2026-12-12'), { code: 'CLUES_COUNT_DROP_REVIEW' });
        await assert.rejects(run(conn, previous, '2026-12-12'), { code: 'CLUES_HISTORICAL_OR_UNVERIFIED_FILE' });
        assert.deepEqual(await releases(), installed);
        console.log('PASS Invalid, truncated or superseded publications preserve the working catalog');

        // Force a SQL failure after release metadata insertion, during the batch of entries.
        const next = source('202612', ['Nueva unidad', 'Segunda unidad', 'Tercera unidad']);
        await conn.query(`CREATE TRIGGER qa_interrupt_import BEFORE INSERT ON sis_catalog_entry FOR EACH ROW
            BEGIN IF NEW.code='QATEST00003' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='qa-entry-interruption'; END IF; END`);
        await assert.rejects(run(conn, next, '2026-12-12'), /qa-entry-interruption/);
        assert.deepEqual(await releases(), installed);
        await conn.query('DROP TRIGGER qa_interrupt_import');
        const recovered = await run(conn, next, '2026-12-12');
        assert.equal(recovered.status, 'installed');
        assert.equal((await releases()).length, 3);
        console.log('PASS Interrupted transaction rolled back and a retry succeeded');
    } finally {
        if (other) await other.end();
        await conn.end();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

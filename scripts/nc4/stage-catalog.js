'use strict';
// NC4/L2: prepara un release "staged" a partir de un XLSX oficial ya descargado. Sin DB ni red.
// Escribe <releaseId>.manifest.json, .entries.jsonl y .relations.jsonl, y comprueba la ida y vuelta.
// No sobrescribe: si ya existe un release con ese id en --out, termina con CATALOG_STAGE_EXISTS.
// Uso: node scripts/nc4/stage-catalog.js --file <xlsx> --family sis.diagnosis --release-id <id>
//      --source-url <url> [--source-version <v>] [--valid-from YYYY-MM-DD --validity-basis publication_label] --out <dir>
const fs = require('node:fs');
const { importXlsxRelease } = require('../../src/domain/sisCatalog/importer');
const { writeStagedRelease, readStagedRelease } = require('../../src/domain/sisCatalog/stagedRelease');

function args(argv) {
    const map = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error('Argumento inválido: ' + argv[i]);
        map[argv[i].slice(2)] = argv[i + 1];
    }
    for (const key of ['file', 'family', 'release-id', 'source-url', 'out']) if (!map[key]) throw new Error('Falta --' + key);
    return map;
}

function main() {
    const a = args(process.argv.slice(2));
    const buffer = fs.readFileSync(a.file);
    const { release, issues } = importXlsxRelease(buffer, {
        releaseId: a['release-id'],
        family: a.family,
        sourceUrl: a['source-url'],
        sourceVersion: a['source-version'] || null,
        downloadedAt: new Date(fs.statSync(a.file).mtime).toISOString(),
        validFrom: a['valid-from'] || null,
        validTo: null,
        validityBasis: a['valid-from'] ? (a['validity-basis'] || 'publication_label') : 'unknown',
        provenance: 'official'
    });
    writeStagedRelease(a.out, release, issues);
    const back = readStagedRelease(a.out, release.manifest.releaseId).release;
    console.log(JSON.stringify({
        releaseId: release.manifest.releaseId, family: release.manifest.family, sha256: release.manifest.sha256,
        contentSha256: back.contentSha256, entries: back.entryCount, relations: back.relationCount, issues: issues.map(i => i.code)
    }));
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.code || 'ERROR', error.message); process.exitCode = 1; }
}

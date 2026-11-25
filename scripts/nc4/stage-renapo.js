'use strict';

// Preparación sin conexión a la base. Descargue el PDF del enlace registrado en renapoImporter.js.
// node scripts/nc4/stage-renapo.js --pdf <reglas-curp.pdf> --tsv scripts/nc4/data/renapo-nacionalidad-2021.tsv --release-id <id> --downloaded-at <fecha ISO UTC de descarga> --out <directorio>
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { importRenapoNationality, SOURCE_URL } = require('../../src/domain/sisCatalog/renapoImporter');
const { writeStagedRelease, readStagedRelease } = require('../../src/domain/sisCatalog/stagedRelease');

function main() {
    const keys = ['pdf', 'tsv', 'release-id', 'downloaded-at', 'out'];
    const options = Object.fromEntries(keys.map(key => [key, { type: 'string' }]));
    options.help = { type: 'boolean', short: 'h' };
    const { values } = parseArgs({ options });
    if (values.help) {
        console.log([
            'Descargue el PDF oficial de RENAPO desde ' + SOURCE_URL,
            'node scripts/nc4/stage-renapo.js --pdf <ruta-pdf> --tsv scripts/nc4/data/renapo-nacionalidad-2021.tsv --release-id <id> --downloaded-at <fecha-UTC-de-descarga> --out <carpeta>',
            'Si cambian los bytes del PDF, coteje nuevamente el Anexo 05 y revise las huellas, la edición y el recuento del lector antes de preparar otro release.'
        ].join('\n'));
        return;
    }
    for (const key of keys) if (!values[key]) throw new Error('Falta --' + key);
    const release = importRenapoNationality(fs.readFileSync(values.pdf), fs.readFileSync(values.tsv), {
        releaseId: values['release-id'], downloadedAt: values['downloaded-at']
    });
    writeStagedRelease(values.out, release);
    const { release: stored } = readStagedRelease(values.out, release.manifest.releaseId);
    console.log(JSON.stringify({
        releaseId: stored.manifest.releaseId, sha256: stored.manifest.sha256, entries: stored.entryCount,
        transcriptionSha256: stored.manifest.columnMapping.transcriptionSha256, contentSha256: stored.contentSha256
    }));
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.code || 'CATALOG_STAGE_FAILED', error.message); process.exitCode = 1; }
}

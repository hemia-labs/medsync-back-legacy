'use strict';

const { getFamily } = require('./families');
const { buildRelease, sha256 } = require('./release');

// Edición cotejada. Revisar ambas huellas y el recuento contra el anexo antes de admitir otra edición.
const PDF_SHA256 = 'b405177e65780701fa19ed32d4562feeb64a6d41197b058d8f3d7cf275465cb4';
const TSV_SHA256 = '8fe5d27e874e5447e7d8f1114089e1814a81a10fff11da4c236cfff9e70d8c06';
const ROW_COUNT = 258;
const SOURCE_URL = 'https://www.gob.mx/cms/uploads/attachment/file/960109/Reglas_para_la_Ejecucion_de_los_Procedimientos_para_la_Asignacion_de_la_CURP.pdf';

function invalid(reason) {
    throw Object.assign(new Error(reason), { code: 'CATALOG_SOURCE_INVALID' });
}

function importRenapoNationality(pdfBuffer, tsvBuffer, { releaseId, downloadedAt }) {
    if (sha256(pdfBuffer) !== PDF_SHA256) invalid('El PDF de RENAPO no coincide con la edición cotejada.');
    if (sha256(tsvBuffer) !== TSV_SHA256) invalid('El TSV no coincide con la transcripción cotejada para este PDF.');
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(tsvBuffer).split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.shift() !== 'code\tlabel' || lines.length !== ROW_COUNT) invalid('Cabecera o recuento inesperado en la transcripción.');

    const entries = lines.map((line, i) => {
        const columns = line.split('\t');
        const [code, label] = columns;
        if (columns.length !== 2 || !/^[A-Z]{3}$/.test(code) || !label || label.trim() !== label) {
            invalid(`Clave o rótulo inválido en la fila ${i + 2} del TSV.`);
        }
        return { code, label };
    });
    const family = 'renapo.nationality';
    const { sourceCatalogName, source } = getFamily(family);
    const timeZone = 'America/Mexico_City';
    const validFrom = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(downloadedAt));
    // buildRelease conserva rótulos iguales con claves distintas y rechaza toda clave duplicada.
    return buildRelease({
        family, releaseId, sourceCatalogName, sourceUrl: SOURCE_URL, sourceVersion: 'Reglas CURP, 17 de diciembre de 2021',
        downloadedAt, sha256: PDF_SHA256, encoding: 'UTF-8', validFrom, validTo: null, validityBasis: 'download_date',
        provenance: 'official', status: 'staged', verifiedAt: null,
        columnMapping: {
            section: 'Anexo 05. Catálogo de Nacionalidades', pages: '164-168',
            code: source.code, label: source.label, transcriptionSha256: TSV_SHA256,
            downloadDateTimeZone: timeZone
        }
    }, entries);
}

module.exports = { importRenapoNationality, SOURCE_URL };

'use strict';
// NC4/L2: convierte un XLSX oficial en un release "staged". No conecta a DB ni a red.
const { readXlsx } = require('./xlsxReader');
const { getFamily } = require('./families');
const { buildRelease, sha256 } = require('./release');

function fail(message) { throw Object.assign(new Error(message), { code: 'CATALOG_IMPORT_INVALID' }); }

function sheetRows(buffer, sheet) {
    const book = readXlsx(buffer);
    const name = typeof sheet === 'number' ? book.sheets[sheet] : sheet;
    if (!name) fail('Hoja no encontrada.');
    return name === book.sheet ? book.rows : readXlsx(buffer, { sheet: name }).rows;
}

// Una celda numérica entera se conserva como su texto literal ("1"). Si el Excel guardó un código con ceros
// iniciales como número, ese cero ya se perdió en origen: se reporta en lugar de inventar un relleno.
function cellCode(cell, row) {
    const value = (cell ? cell.value : '').trim();
    if (!value) fail(`Código vacío en la fila ${row + 1}.`);
    if (cell.type === 'n' && !/^\d+$/.test(value)) fail(`Código numérico no entero en la fila ${row + 1}: ${value}`);
    return { code: value, numericCell: cell.type === 'n' };
}

function headerIndex(rows, headerRow) {
    const header = (rows[headerRow] || []).map(c => c.value.trim());
    const index = name => {
        const i = header.indexOf(name);
        if (i < 0) fail(`Columna ausente: ${name}. Encabezados: ${header.join(', ')}`);
        return i;
    };
    return { header, index };
}

/**
 * @param {Buffer} buffer archivo XLSX oficial
 * @param {object} meta campos del manifiesto que no salen del archivo (releaseId, family, sourceUrl, ...)
 * @returns {{ release, issues: object[] }}
 */
function importXlsxRelease(buffer, meta) {
    const family = getFamily(meta.family);
    if (family?.source?.sheet === undefined) fail(`La familia ${meta.family} no tiene lector XLSX configurado.`);
    const cfg = family.source;
    const sourceSha256 = sha256(buffer);
    const reviewedHeaders = cfg.reviewedHeaders?.[sourceSha256];
    const reviewedVariant = cfg.reviewedVariants?.[sourceSha256];
    const rows = sheetRows(buffer, cfg.sheet);
    const { index } = headerIndex(rows, cfg.headerRow);
    const codeAt = index(cfg.code), labelAt = index(cfg.label);
    const attrAt = cfg.attributes.map(name => [name, index(reviewedHeaders?.[name] ?? name)]);
    const issues = [];
    const entries = [];
    let numericCells = 0;
    for (let r = cfg.headerRow + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row.some(c => c.value.trim())) continue;
        const { code, numericCell } = cellCode(row[codeAt], r);
        if (numericCell) numericCells++;
        const attributes = {};
        for (const [name, i] of attrAt) attributes[name] = row[i] ? row[i].value.trim() : '';
        const label = row[labelAt]?.value.trim() || '';
        if (meta.family === 'sis.referral_service') {
            if (!label) fail(`Especialidad sin nombre en la fila ${r + 1}.`);
            for (const profile of ['REF CE', 'REF SB']) {
                if (attributes[profile] !== '' && attributes[profile] !== 'X') fail(`Marca inválida para ${profile} en la fila ${r + 1}.`);
            }
        }
        if (reviewedVariant && r + 1 === reviewedVariant.variantRow) {
            const primary = entries.find(entry => entry.code === reviewedVariant.code);
            if (!primary || code !== reviewedVariant.code) fail('La variante no coincide con la clave revisada.');
            primary.attributes[reviewedVariant.attribute] = JSON.stringify({ label, ...attributes });
            continue;
        }
        entries.push({ code, label, attributes });
    }
    if (numericCells) issues.push({ code: 'NUMERIC_CODE_CELLS', count: numericCells, message: 'Códigos guardados como número en el Excel; se conservan como texto literal sin rellenar ceros.' });

    const relations = [];
    if (family.relation) {
        const rel = family.relation;
        const relRows = sheetRows(buffer, rel.sheet);
        const header = relRows[rel.headerRow].map(c => c.value.trim());
        const rightAt = header.indexOf(rel.rightCode);
        if (rightAt < 0) fail('Columna de relación ausente: ' + rel.rightCode);
        const personnelByColumn = header.map(h => /^(\d+)\s*[.\-–—]/u.exec(h)?.[1]);
        if (!personnelByColumn.some(Boolean)) fail('No se encontraron columnas de tipo de personal en la hoja de relación.');
        for (let r = rel.headerRow + 1; r < relRows.length; r++) {
            const row = relRows[r];
            const right = row[rightAt]?.value.trim();
            row.forEach((cell, column) => {
                if (column === rightAt || header[column] === 'SERVICIOS_ATENCION') return;
                const mark = cell.value.trim().toUpperCase();
                if (!mark) return;
                const left = personnelByColumn[column];
                if (mark === 'X') {
                    if (!left || !right) fail(`Marca X sin tipo de personal o servicio en fila ${r + 1}, columna ${column + 1}.`);
                    relations.push({ left, right });
                } else if (left) {
                    fail(`Marca desconocida en la matriz, fila ${r + 1}, columna ${column + 1}.`);
                }
            });
        }
    }
    const manifest = {
        sourceCatalogName: family.sourceCatalogName,
        encoding: 'xlsx/utf-8',
        columnMapping: {
            sheet: cfg.sheet, code: cfg.code, label: cfg.label, attributes: cfg.attributes,
            ...(reviewedHeaders && { reviewedHeaders }),
            ...(reviewedVariant && { reviewedVariant }),
            relationSheet: family.relation ? family.relation.sheet : null,
            relationLeftFamily: family.relation ? family.relation.leftFamily : null
        },
        status: 'staged',
        verifiedAt: null,
        ...meta,
        sha256: sourceSha256
    };
    if (manifest.status !== 'staged' || manifest.verifiedAt !== null) fail('Un import siempre produce un release staged; la verificación es un paso aparte.');
    return { release: buildRelease(manifest, entries, { relations, sourceBuffer: buffer }), issues };
}

module.exports = { importXlsxRelease };

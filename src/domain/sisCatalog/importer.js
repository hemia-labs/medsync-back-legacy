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
    if (!family || !family.source) fail(`La familia ${meta.family} no tiene lector configurado.`);
    const cfg = family.source;
    const rows = sheetRows(buffer, cfg.sheet);
    const { index } = headerIndex(rows, cfg.headerRow);
    const codeAt = index(cfg.code), labelAt = index(cfg.label);
    const attrAt = cfg.attributes.map(name => [name, index(name)]);
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
        entries.push({ code, label: row[labelAt] ? row[labelAt].value.trim() : '', attributes });
    }
    if (numericCells) issues.push({ code: 'NUMERIC_CODE_CELLS', count: numericCells, message: 'Códigos guardados como número en el Excel; se conservan como texto literal sin rellenar ceros.' });

    const relations = [];
    if (family.relation) {
        const rel = family.relation;
        const relRows = sheetRows(buffer, rel.sheet);
        const header = relRows[rel.headerRow].map(c => c.value.trim());
        const rightAt = header.indexOf(rel.rightCode);
        if (rightAt < 0) fail('Columna de relación ausente: ' + rel.rightCode);
        const leftColumns = header.map((h, i) => [i, (h.match(/^(\d+)\s*[.-]/) || [])[1]]).filter(([, code]) => code);
        if (!leftColumns.length) fail('No se encontraron columnas de tipo de personal en la hoja de relación.');
        for (let r = rel.headerRow + 1; r < relRows.length; r++) {
            const row = relRows[r];
            if (!row[rightAt] || !row[rightAt].value.trim()) continue;
            const right = row[rightAt].value.trim();
            for (const [i, left] of leftColumns) if (row[i] && row[i].value.trim().toUpperCase() === 'X') relations.push({ left, right });
        }
    }
    const manifest = {
        sourceCatalogName: family.sourceCatalogName,
        encoding: 'xlsx/utf-8',
        columnMapping: {
            sheet: cfg.sheet, code: cfg.code, label: cfg.label, attributes: cfg.attributes,
            relationSheet: family.relation ? family.relation.sheet : null,
            relationLeftFamily: family.relation ? family.relation.leftFamily : null
        },
        status: 'staged',
        verifiedAt: null,
        ...meta,
        sha256: sha256(buffer)
    };
    if (manifest.status !== 'staged' || manifest.verifiedAt !== null) fail('Un import siempre produce un release staged; la verificación es un paso aparte.');
    return { release: buildRelease(manifest, entries, { relations, sourceBuffer: buffer }), issues };
}

module.exports = { importXlsxRelease };

'use strict';
// NC4/L2: lector XLSX mínimo y sin dependencias para catálogos oficiales DGIS.
// Solo lee: no evalúa fórmulas, macros ni relaciones externas. Trata el archivo como dato no confiable.
const zlib = require('node:zlib');

const LIMITS = Object.freeze({ entries: 2000, entryBytes: 256 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 });

function fail(message) { throw Object.assign(new Error(message), { code: 'XLSX_INVALID' }); }

function readZip(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) fail('Archivo XLSX vacío o truncado.');
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) fail('No es un ZIP válido (sin directorio central).');
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    if (count > LIMITS.entries) fail('Demasiadas entradas en el XLSX.');
    const entries = new Map();
    let total = 0;
    for (let n = 0; n < count; n++) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) fail('Directorio central dañado.');
        const method = buffer.readUInt16LE(offset + 10);
        const compressed = buffer.readUInt32LE(offset + 20);
        const size = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const local = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + extraLength + commentLength;
        if (size > LIMITS.entryBytes || (total += size) > LIMITS.totalBytes) fail('Contenido descomprimido excesivo.');
        entries.set(name, { method, compressed, size, local });
    }
    return {
        names: [...entries.keys()],
        read(name) {
            const e = entries.get(name);
            if (!e) return null;
            if (buffer.readUInt32LE(e.local) !== 0x04034b50) fail('Cabecera local dañada.');
            const start = e.local + 30 + buffer.readUInt16LE(e.local + 26) + buffer.readUInt16LE(e.local + 28);
            const raw = buffer.subarray(start, start + e.compressed);
            let data;
            if (e.method === 0) data = raw;
            else if (e.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.entryBytes });
            else fail('Compresión ZIP no soportada: ' + e.method);
            if (data.length !== e.size) fail('Tamaño descomprimido inconsistente en ' + name);
            return data.toString('utf8');
        }
    };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text) {
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
        if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
        return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
    });
}
const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"')); return m ? decode(m[1]) : null; };
const textOf = xml => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));

function columnIndex(ref) {
    const letters = ref.match(/^[A-Z]+/)[0];
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

/**
 * Devuelve { sheets: [nombre], rows: [[{ value, type }]] } de la hoja pedida (por defecto la primera).
 * type: 's' cadena compartida, 'str'/'inlineStr' texto, 'n' número tal como está escrito, 'b' booleano.
 * Los números se devuelven como el texto literal del XML: el importador decide si un código perdió ceros.
 */
function readXlsx(buffer, { sheet } = {}) {
    const zip = readZip(buffer);
    const workbook = zip.read('xl/workbook.xml');
    if (!workbook) fail('Falta xl/workbook.xml.');
    const sheets = [...workbook.matchAll(/<sheet\b[^>]*\/?>/g)].map(m => ({ name: attr(m[0], 'name'), rid: attr(m[0], 'r:id') }));
    if (!sheets.length) fail('El libro no tiene hojas.');
    const chosen = sheet === undefined ? sheets[0] : sheets.find(s => s.name === sheet);
    if (!chosen) fail('Hoja no encontrada: ' + sheet);
    const rels = zip.read('xl/_rels/workbook.xml.rels') || '';
    const rel = [...rels.matchAll(/<Relationship\b[^>]*\/?>/g)].map(m => m[0]).find(r => attr(r, 'Id') === chosen.rid);
    if (!rel) fail('Relación de hoja ausente.');
    let target = attr(rel, 'Target').replace(/^\//, '');
    if (!target.startsWith('xl/')) target = 'xl/' + target;
    const sheetXml = zip.read(target);
    if (sheetXml === null) fail('Hoja ausente en el ZIP: ' + target);
    const sharedXml = zip.read('xl/sharedStrings.xml');
    const shared = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1])) : [];
    const rows = [];
    for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
        const row = [];
        for (const c of (rowMatch[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const ref = attr(' ' + c[1], 'r');
            const type = attr(' ' + c[1], 't') || 'n';
            const body = c[2] || '';
            const v = body.match(/<v>([\s\S]*?)<\/v>/);
            let value;
            if (type === 's') value = v ? shared[Number(v[1])] : '';
            else if (type === 'inlineStr') value = textOf(body);
            else value = v ? decode(v[1]) : '';
            const index = ref ? columnIndex(ref) : row.length;
            row[index] = { value: value === undefined ? '' : value, type };
        }
        for (let i = 0; i < row.length; i++) if (!row[i]) row[i] = { value: '', type: 'blank' };
        rows.push(row);
    }
    return { sheets: sheets.map(s => s.name), sheet: chosen.name, rows };
}

module.exports = { readXlsx, readZip, LIMITS };

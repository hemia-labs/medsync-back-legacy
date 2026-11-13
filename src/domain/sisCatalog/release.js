'use strict';
// NC4/L2: manifiesto y release inmutable de catálogo (contrato NC1 v1 §5).
const { createHash } = require('node:crypto');
const { CODE_RE, FAMILY_RE, RELEASE_RE, LIMITS } = require('./catalogRef');
const { getFamily } = require('./families');

const STATUSES = Object.freeze(['staged', 'verified', 'retired']);
const PROVENANCES = Object.freeze(['official', 'synthetic']);
// Cómo se conoce la vigencia: la DGIS no publica fechas de vigencia en los archivos.
const VALIDITY_BASES = Object.freeze(['official', 'publication_label', 'download_date', 'unknown']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message, code = 'CATALOG_RELEASE_INVALID') { throw Object.assign(new Error(message), { code }); }
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

function validDate(value) {
    if (!DATE_RE.test(value)) return false;
    const d = new Date(value + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function validateManifest(m) {
    if (!m || typeof m !== 'object') fail('Manifiesto ausente.');
    const required = ['releaseId', 'family', 'sourceCatalogName', 'sourceUrl', 'sourceVersion', 'downloadedAt', 'sha256',
        'encoding', 'validFrom', 'validTo', 'validityBasis', 'provenance', 'status', 'columnMapping'];
    for (const key of required) if (!Object.prototype.hasOwnProperty.call(m, key)) fail(`Falta ${key} en el manifiesto.`);
    if (typeof m.releaseId !== 'string' || m.releaseId.length > LIMITS.releaseId || !RELEASE_RE.test(m.releaseId)) fail('releaseId inválido.');
    if (typeof m.family !== 'string' || !FAMILY_RE.test(m.family) || !getFamily(m.family)) fail('Familia desconocida: ' + m.family);
    if (!/^[a-f0-9]{64}$/.test(m.sha256)) fail('sha256 debe tener 64 hexadecimales en minúsculas.');
    if (!PROVENANCES.includes(m.provenance)) fail('provenance debe ser official o synthetic.');
    if (!STATUSES.includes(m.status)) fail('status debe ser staged, verified o retired.');
    if (!VALIDITY_BASES.includes(m.validityBasis)) fail('validityBasis inválida.');
    for (const key of ['validFrom', 'validTo']) if (m[key] !== null && !validDate(m[key])) fail(`${key} debe ser YYYY-MM-DD o null.`);
    if (m.validFrom && m.validTo && m.validTo <= m.validFrom) fail('validTo es exclusivo y debe ser posterior a validFrom.');
    if (m.validFrom === null && m.validityBasis !== 'unknown') fail('Sin validFrom la base de vigencia debe ser unknown.');
    if (Number.isNaN(Date.parse(m.downloadedAt))) fail('downloadedAt debe ser una fecha ISO.');
    if (m.sourceVersion !== null && typeof m.sourceVersion !== 'string') fail('sourceVersion debe ser string o null.');
    if (m.provenance === 'synthetic' && m.status === 'verified' && m.sourceUrl) fail('Un fixture sintético no puede presentarse con URL oficial.');
}

/**
 * Construye un release congelado. `entries`: [{ code, label, attributes }]; `relations`: [{ left, right }].
 * Si se pasa `sourceBuffer`, su hash debe coincidir con el manifiesto.
 */
function buildRelease(manifest, entries, { relations = [], sourceBuffer } = {}) {
    validateManifest(manifest);
    if (sourceBuffer && sha256(sourceBuffer) !== manifest.sha256) fail('El hash del archivo no coincide con el manifiesto.', 'CATALOG_SHA_MISMATCH');
    const family = getFamily(manifest.family);
    const map = new Map();
    for (const entry of entries) {
        const code = entry && entry.code;
        if (typeof code !== 'string' || !code.length || code.length > LIMITS.code || !CODE_RE.test(code)) {
            fail(`Código inválido en ${manifest.family}: ${JSON.stringify(code)}`, 'CATALOG_CODE_INVALID');
        }
        if (family.codePattern && !family.codePattern.test(code)) fail(`Código fuera del patrón de ${manifest.family}: ${code}`, 'CATALOG_CODE_INVALID');
        if (map.has(code)) fail(`Código duplicado en ${manifest.family}: ${code}`, 'CATALOG_CODE_DUPLICATE');
        map.set(code, Object.freeze({
            code,
            label: typeof entry.label === 'string' ? entry.label : '',
            attributes: Object.freeze({ ...(entry.attributes || {}) }),
            sentinel: (family.sentinelCodes || []).includes(code)
        }));
    }
    const pairs = new Set();
    for (const r of relations) {
        if (!map.has(r.right)) fail(`La relación usa un código inexistente: ${r.right}`, 'CATALOG_RELATION_INVALID');
        pairs.add(`${r.left}\u0000${r.right}`);
    }
    return Object.freeze({
        manifest: Object.freeze({ ...manifest, columnMapping: Object.freeze({ ...manifest.columnMapping }) }),
        entries: map,
        pairs,
        entryCount: map.size
    });
}

module.exports = { STATUSES, PROVENANCES, VALIDITY_BASES, validateManifest, buildRelease, sha256, validDate };

'use strict';
// NC4/L2: manifiesto y release inmutable de catálogo (contrato NC1 v1.1 §5).
// L2-R2: el release no expone Map/Set; solo funciones de lectura sobre copias congeladas.
// L2-R3: las invariantes de estado se validan en un único lugar (assertStatusInvariants) y las usan
//        buildRelease, CatalogRegistry.add y CatalogRegistry.setStatus.
const { createHash } = require('node:crypto');
const { CODE_RE, FAMILY_RE, RELEASE_RE, LIMITS } = require('./catalogRef');
const { getFamily } = require('./families');

const STATUSES = Object.freeze(['staged', 'verified', 'retired']);
const PROVENANCES = Object.freeze(['official', 'synthetic']);
// Cómo se conoce la vigencia: la DGIS no publica fechas de vigencia en los archivos.
const VALIDITY_BASES = Object.freeze(['official', 'publication_label', 'download_date', 'unknown']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Campos del manifiesto (contrato §5) más verifiedAt: evidencia de que el release estuvo verificado (L2-R6).
const MANIFEST_KEYS = Object.freeze(['releaseId', 'family', 'sourceCatalogName', 'sourceUrl', 'sourceVersion', 'downloadedAt', 'sha256',
    'encoding', 'validFrom', 'validTo', 'validityBasis', 'provenance', 'status', 'verifiedAt', 'columnMapping']);

const BRAND = new WeakSet();

function fail(message, code = 'CATALOG_RELEASE_INVALID') { throw Object.assign(new Error(message), { code }); }
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

function validDate(value) {
    if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
    const d = new Date(value + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
const validInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));

function deepFreezeClone(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeClone));
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) out[key] = deepFreezeClone(value[key]);
        return Object.freeze(out);
    }
    return value;
}

function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
}

/** Invariantes de estado compartidas por construcción, registro y transición (L2-R3). */
function assertStatusInvariants(m, status = m.status, verifiedAt = m.verifiedAt) {
    if (!STATUSES.includes(status)) fail('status debe ser staged, verified o retired.');
    if (verifiedAt !== null && !validInstant(verifiedAt)) fail('verifiedAt debe ser un instante ISO o null.');
    if (status === 'staged' && verifiedAt !== null) fail('Un release staged no tiene verifiedAt.', 'CATALOG_STATUS_INVARIANT');
    if (status === 'verified' && verifiedAt === null) fail('Un release verified requiere verifiedAt.', 'CATALOG_STATUS_INVARIANT');
    if (verifiedAt !== null) {
        if (m.provenance !== 'official') fail('Un fixture sintético no puede verificarse como release oficial.', 'CATALOG_SYNTHETIC_NOT_OFFICIAL');
        if (!m.validFrom || m.validityBasis === 'unknown') fail('Para verificar un release hace falta validFrom con una base de vigencia conocida.', 'CATALOG_VALIDITY_REQUIRED');
    }
}

function validateManifest(m) {
    if (!m || typeof m !== 'object') fail('Manifiesto ausente.');
    for (const key of MANIFEST_KEYS) if (!Object.prototype.hasOwnProperty.call(m, key)) fail(`Falta ${key} en el manifiesto.`);
    const extra = Object.keys(m).filter(k => !MANIFEST_KEYS.includes(k));
    if (extra.length) fail('Campos desconocidos en el manifiesto: ' + extra.join(', '));
    if (typeof m.releaseId !== 'string' || m.releaseId.length > LIMITS.releaseId || !RELEASE_RE.test(m.releaseId)) fail('releaseId inválido.');
    if (typeof m.family !== 'string' || !FAMILY_RE.test(m.family) || !getFamily(m.family)) fail('Familia desconocida: ' + m.family);
    if (typeof m.sourceCatalogName !== 'string' || !m.sourceCatalogName) fail('sourceCatalogName es obligatorio.');
    if (m.sourceUrl !== null && typeof m.sourceUrl !== 'string') fail('sourceUrl debe ser string o null.');
    if (m.sourceVersion !== null && typeof m.sourceVersion !== 'string') fail('sourceVersion debe ser string o null.');
    if (typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256)) fail('sha256 debe tener 64 hexadecimales en minúsculas.');
    if (typeof m.encoding !== 'string' || !/^[\x21-\x7E]{1,40}$/.test(m.encoding)) fail('encoding inválido.');
    if (!PROVENANCES.includes(m.provenance)) fail('provenance debe ser official o synthetic.');
    if (!VALIDITY_BASES.includes(m.validityBasis)) fail('validityBasis inválida.');
    for (const key of ['validFrom', 'validTo']) if (m[key] !== null && !validDate(m[key])) fail(`${key} debe ser YYYY-MM-DD o null.`);
    if (m.validTo && !m.validFrom) fail('validTo requiere validFrom.');
    if (m.validFrom && m.validTo && m.validTo <= m.validFrom) fail('validTo es exclusivo y debe ser posterior a validFrom.');
    // Igual que chk_sis_release_basis_date del DDL: hay fecha si y solo si la base de vigencia es conocida.
    if ((m.validFrom === null) !== (m.validityBasis === 'unknown')) fail('validFrom y validityBasis deben ser coherentes: fecha solo con base conocida.');
    if (!validInstant(m.downloadedAt)) fail('downloadedAt debe ser una fecha ISO.');
    if (!m.columnMapping || typeof m.columnMapping !== 'object' || Array.isArray(m.columnMapping)) fail('columnMapping debe ser un objeto.');
    assertStatusInvariants(m);
}

function freezeEntry(family, entry, manifestFamily) {
    const code = entry && entry.code;
    if (typeof code !== 'string' || !code.length || code.length > LIMITS.code || !CODE_RE.test(code)) {
        fail(`Código inválido en ${manifestFamily}: ${JSON.stringify(code)}`, 'CATALOG_CODE_INVALID');
    }
    if (family.codePattern && !family.codePattern.test(code)) fail(`Código fuera del patrón de ${manifestFamily}: ${code}`, 'CATALOG_CODE_INVALID');
    const attributes = {};
    for (const [key, value] of Object.entries((entry && entry.attributes) || {})) {
        if (typeof value !== 'string') fail(`El atributo ${key} de ${code} debe ser string.`, 'CATALOG_ATTRIBUTE_INVALID');
        attributes[key] = value;
    }
    return Object.freeze({
        code,
        label: typeof entry.label === 'string' ? entry.label : '',
        attributes: Object.freeze(attributes),
        sentinel: (family.sentinelCodes || []).includes(code)
    });
}

/**
 * Construye un release congelado. `entries`: [{ code, label, attributes }]; `relations`: [{ left, right }].
 * Si se pasa `sourceBuffer`, su hash debe coincidir con el manifiesto.
 */
function buildRelease(manifest, entries, { relations = [], sourceBuffer } = {}) {
    validateManifest(manifest);
    if (sourceBuffer && sha256(sourceBuffer) !== manifest.sha256) fail('El hash del archivo no coincide con el manifiesto.', 'CATALOG_SHA_MISMATCH');
    if (!Array.isArray(entries) || !Array.isArray(relations)) fail('entries y relations deben ser arreglos.');
    const family = getFamily(manifest.family);
    const map = new Map();
    for (const entry of entries) {
        const frozen = freezeEntry(family, entry, manifest.family);
        if (map.has(frozen.code)) fail(`Código duplicado en ${manifest.family}: ${frozen.code}`, 'CATALOG_CODE_DUPLICATE');
        map.set(frozen.code, frozen);
    }
    if (relations.length && !family.relation) fail(`La familia ${manifest.family} no admite relaciones.`, 'CATALOG_RELATION_INVALID');
    const pairs = new Map();
    for (const r of relations) {
        if (!r || typeof r.left !== 'string' || typeof r.right !== 'string' || !CODE_RE.test(r.left) || r.left.length > LIMITS.code) fail('Relación inválida.', 'CATALOG_RELATION_INVALID');
        if (!map.has(r.right)) fail(`La relación usa un código inexistente: ${r.right}`, 'CATALOG_RELATION_INVALID');
        const key = `${r.left}\u0000${r.right}`;
        if (pairs.has(key)) fail(`Relación duplicada: ${r.left}/${r.right}`, 'CATALOG_RELATION_DUPLICATE');
        pairs.set(key, Object.freeze({ left: r.left, right: r.right }));
    }
    const sortedEntries = [...map.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const sortedPairs = [...pairs.values()].sort((a, b) => (a.left + '\u0000' + a.right < b.left + '\u0000' + b.right ? -1 : 1));
    const contentSha256 = sha256(canonical({ family: manifest.family, entries: sortedEntries, relations: sortedPairs }));
    const frozenManifest = deepFreezeClone(manifest);
    const release = Object.freeze({
        manifest: frozenManifest,
        entryCount: map.size,
        relationCount: pairs.size,
        contentSha256,
        get: code => map.get(code) || null,
        has: code => map.has(code),
        codes: () => sortedEntries.map(e => e.code),
        list: () => sortedEntries.slice(),
        hasPair: (left, right) => pairs.has(`${left}\u0000${right}`),
        pairs: () => sortedPairs.slice()
    });
    BRAND.add(release);
    return release;
}

const isRelease = value => BRAND.has(value);

module.exports = {
    STATUSES, PROVENANCES, VALIDITY_BASES, MANIFEST_KEYS,
    validateManifest, assertStatusInvariants, buildRelease, isRelease, sha256, validDate, canonical
};

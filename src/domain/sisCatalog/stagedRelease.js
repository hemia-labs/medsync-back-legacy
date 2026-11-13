'use strict';
// NC4/L2 (L2-R4): artefactos de staging con ida y vuelta completa: manifiesto, entradas y relaciones.
// Nunca sobrescribe un release existente: si algún archivo del mismo releaseId ya existe, falla sin escribir nada.
const fs = require('node:fs');
const path = require('node:path');
const { buildRelease, MANIFEST_KEYS } = require('./release');

const SUFFIXES = Object.freeze({ manifest: '.manifest.json', entries: '.entries.jsonl', relations: '.relations.jsonl' });
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const paths = (dir, releaseId) => Object.fromEntries(Object.entries(SUFFIXES).map(([k, s]) => [k, path.join(dir, releaseId + s)]));
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

function writeStagedRelease(dir, release, issues = []) {
    if (release.manifest.status !== 'staged') fail('Solo se escriben artefactos de releases staged.', 'CATALOG_STAGE_STATUS');
    fs.mkdirSync(dir, { recursive: true });
    const p = paths(dir, release.manifest.releaseId);
    const existing = Object.values(p).filter(f => fs.existsSync(f));
    if (existing.length) fail('Ya existe un release staged con ese id: ' + existing.map(f => path.basename(f)).join(', '), 'CATALOG_STAGE_EXISTS');
    const manifest = {
        ...release.manifest,
        staging: { entryCount: release.entryCount, relationCount: release.relationCount, contentSha256: release.contentSha256, issues }
    };
    const written = [];
    try {
        // 'wx': falla si el archivo apareció entre la comprobación y la escritura.
        fs.writeFileSync(p.entries, jsonl(release.list().map(e => ({ code: e.code, label: e.label, attributes: e.attributes }))), { flag: 'wx' }); written.push(p.entries);
        fs.writeFileSync(p.relations, jsonl(release.pairs()), { flag: 'wx' }); written.push(p.relations);
        fs.writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }); written.push(p.manifest);
    } catch (e) {
        for (const f of written) fs.rmSync(f, { force: true });
        throw e.code === 'EEXIST' ? Object.assign(e, { code: 'CATALOG_STAGE_EXISTS' }) : e;
    }
    return p;
}

function readLines(file) {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter(line => line.trim()).map((line, i) => {
        try { return JSON.parse(line); } catch { return fail(`Línea ${i + 1} inválida en ${path.basename(file)}.`, 'CATALOG_STAGE_CORRUPT'); }
    });
}

/** Reconstruye el release y comprueba conteos y hash de contenido contra el manifiesto escrito. */
function readStagedRelease(dir, releaseId) {
    const p = paths(dir, releaseId);
    for (const f of Object.values(p)) if (!fs.existsSync(f)) fail('Falta el artefacto ' + path.basename(f), 'CATALOG_STAGE_CORRUPT');
    const raw = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
    const { staging, ...rest } = raw;
    if (!staging) fail('El manifiesto no tiene sección staging.', 'CATALOG_STAGE_CORRUPT');
    const manifest = Object.fromEntries(MANIFEST_KEYS.map(k => [k, rest[k]]));
    const extra = Object.keys(rest).filter(k => !MANIFEST_KEYS.includes(k));
    if (extra.length) fail('Campos inesperados en el manifiesto: ' + extra.join(', '), 'CATALOG_STAGE_CORRUPT');
    if (manifest.releaseId !== releaseId) fail('El releaseId del manifiesto no coincide con el archivo.', 'CATALOG_STAGE_CORRUPT');
    const release = buildRelease(manifest, readLines(p.entries), { relations: readLines(p.relations) });
    if (release.entryCount !== staging.entryCount || release.relationCount !== staging.relationCount || release.contentSha256 !== staging.contentSha256) {
        fail('El contenido no coincide con los conteos o el hash registrados.', 'CATALOG_STAGE_CORRUPT');
    }
    return { release, issues: staging.issues || [] };
}

module.exports = { writeStagedRelease, readStagedRelease, SUFFIXES };

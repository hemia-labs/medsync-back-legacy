'use strict';
// NC3: control de integridad de las notas de evolución firmadas.
// Formato, referencia protegida y verificación. Ver
// docs/normative-compliance/phases/PHASE_NC3_INTEGRIDAD_NOTAS_FIRMADAS_20261121.md.
// Nada de lo que se registra aquí contiene texto clínico: solo identificadores y códigos.
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { QueryTypes } = require('sequelize');

const FORMAT = 'nc3-evolution-v1';
const GENESIS = '0'.repeat(64);
const RANK = { verified: 0, historical: 1, unavailable: 2, discrepancy: 3 };
const TEXT_TIME = "%Y-%m-%d %H:%i:%s.%f";
const ROW_SELECT = `n.*, DATE_FORMAT(n.signed_at,'${TEXT_TIME}') AS signed_at_text`;

class IntegritySealError extends Error {
    constructor(code, cause) { super(code); this.code = code; this.cause = cause; this.integrity = true; }
}

// JSON con claves ordenadas recursivamente y sin espacios: representación estable.
function stable(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined)
        .map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest('hex');
function same(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function config(env = process.env) {
    const keys = new Map();
    for (const part of String(env.EVOLUTION_INTEGRITY_KEYS || '').split(',')) {
        const [id, hex] = part.trim().split(':');
        if (/^[A-Za-z0-9_-]{1,40}$/.test(id || '') && /^[0-9a-fA-F]{64,}$/.test(hex || '')) keys.set(id, Buffer.from(hex, 'hex'));
    }
    const wanted = env.EVOLUTION_INTEGRITY_KEY_ID || [...keys.keys()][0] || '';
    let adoptionAt = null;
    if (env.EVOLUTION_INTEGRITY_ADOPTION_AT) {
        const parsed = new Date(env.EVOLUTION_INTEGRITY_ADOPTION_AT);
        if (!Number.isNaN(parsed.getTime())) adoptionAt = parsed.toISOString().replace('T', ' ').replace('Z', '000');
    }
    return { keys, current: keys.has(wanted) ? { id: wanted, key: keys.get(wanted) } : null, adoptionAt };
}

// Qué queda protegido al firmar (formato nc3-evolution-v1).
function document(row) {
    return {
        format: FORMAT, business: row.id_business, patient: row.id_person, note: row.note_id, version: Number(row.version),
        author: row.author_id, signerProfile: row.signer_profile, signerName: row.signer_name, signerLicense: row.signer_license,
        signedAt: row.signed_at_text, correctionReason: row.correction_reason ?? null,
        form: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    };
}
const FORMATS = { [FORMAT]: row => sha256(stable(document(row))) };
const digest = row => FORMATS[FORMAT](row);

const entryMac = (key, e) => hmac(key, stable({
    k: 'entry', format: e.format, business: e.id_business, patient: e.id_person, seq: Number(e.seq), note: e.note_id,
    version: Number(e.version), digest: e.digest, previousDigest: e.previous_digest || null, prevMac: e.prev_mac,
    sealedAt: e.sealed_at_text, keyId: e.key_id
}));
const headMac = (key, h) => hmac(key, stable({
    k: 'head', business: h.id_business, patient: h.id_person, lastSeq: Number(h.last_seq), lastMac: h.last_mac, keyId: h.key_id
}));

async function loadReference(db, transaction, scope, lock = false) {
    const suffix = lock ? ' FOR UPDATE' : '';
    const where = 'id_business=:business AND id_person=:patient';
    const entries = await db.query(`SELECT *, DATE_FORMAT(sealed_at,'${TEXT_TIME}') AS sealed_at_text FROM evolution_integrity_ledger WHERE ${where} ORDER BY seq${suffix}`,
        { transaction, replacements: scope, type: QueryTypes.SELECT });
    const [head] = await db.query(`SELECT * FROM evolution_integrity_head WHERE ${where}${suffix}`,
        { transaction, replacements: scope, type: QueryTypes.SELECT });
    return { entries, head: head || null };
}

// Verificación pura. rows: versiones de la base (con signed_at_text); entries/head: referencia protegida.
// onlyNote limita las comprobaciones por versión a una nota; la cadena se comprueba siempre completa.
function verify({ rows, entries, head, cfg, onlyNote = null }) {
    const states = new Map();
    const faults = [];
    const rowKey = (note, version) => note + '#' + Number(version);
    const raise = (note, version, state, code) => {
        const key = rowKey(note, version), prior = states.get(key);
        if (!prior || RANK[state] > RANK[prior.state]) states.set(key, { note, version: Number(version), state, code });
    };
    const fault = (code, state = 'discrepancy') => { if (!faults.some(f => f.code === code)) faults.push({ code, state }); };
    const rowMap = new Map(rows.map(r => [rowKey(r.note_id, r.version), r]));
    const inScope = note => !onlyNote || note === onlyNote;
    const sorted = entries.slice().sort((a, b) => Number(a.seq) - Number(b.seq));
    const trusted = new Map();
    let previous = null;
    for (const e of sorted) {
        const key = cfg.keys.get(e.key_id), supported = FORMATS[e.format];
        let okMac = false;
        if (!key || !supported) {
            fault(!key ? 'KEY_UNAVAILABLE' : 'FORMAT_UNSUPPORTED', 'unavailable');
            if (inScope(e.note_id)) raise(e.note_id, e.version, 'unavailable', !key ? 'KEY_UNAVAILABLE' : 'FORMAT_UNSUPPORTED');
        } else if (!same(entryMac(key, e), e.mac)) {
            fault('LEDGER_ENTRY_INVALID');
            if (inScope(e.note_id)) raise(e.note_id, e.version, 'discrepancy', 'LEDGER_ENTRY_INVALID');
        } else { okMac = true; trusted.set(rowKey(e.note_id, e.version), e); }
        const expected = previous ? Number(previous.seq) + 1 : 1;
        if (Number(e.seq) !== expected) fault('LEDGER_GAP');
        else if (previous && e.prev_mac !== previous.mac) fault('LEDGER_CHAIN_BROKEN');
        else if (!previous && e.prev_mac !== GENESIS) fault('LEDGER_CHAIN_BROKEN');
        previous = e;
        e.__trusted = okMac;
    }
    const last = sorted[sorted.length - 1] || null;
    if (head) {
        const key = cfg.keys.get(head.key_id);
        if (!key) fault('KEY_UNAVAILABLE', 'unavailable');
        else if (!same(headMac(key, head), head.mac)) fault('HEAD_INVALID');
        else if (!last || Number(head.last_seq) !== Number(last.seq) || head.last_mac !== last.mac)
            fault(Number(head.last_seq) > (last ? Number(last.seq) : 0) ? 'LEDGER_TRUNCATED' : 'HEAD_MISMATCH');
    } else if (sorted.length) fault('HEAD_MISSING');

    const byNote = new Map();
    for (const e of sorted) { if (!byNote.has(e.note_id)) byNote.set(e.note_id, []); byNote.get(e.note_id).push(e); }
    for (const e of sorted) {
        if (!e.__trusted || !inScope(e.note_id)) continue;
        const row = rowMap.get(rowKey(e.note_id, e.version));
        if (!row) raise(e.note_id, e.version, 'discrepancy', 'VERSION_MISSING');
        else if (!same(FORMATS[e.format](row), e.digest)) raise(e.note_id, e.version, 'discrepancy', 'CONTENT_MISMATCH');
        else raise(e.note_id, e.version, 'verified', null);
        if (Number(e.version) > 1) {
            const before = trusted.get(rowKey(e.note_id, Number(e.version) - 1));
            const beforeRow = rowMap.get(rowKey(e.note_id, Number(e.version) - 1));
            if (before) { if (e.previous_digest !== before.digest) raise(e.note_id, e.version, 'discrepancy', 'LINK_MISMATCH'); }
            else if (!beforeRow) raise(e.note_id, Number(e.version) - 1, 'discrepancy', 'VERSION_MISSING');
            else if (e.previous_digest && !same(FORMATS[e.format](beforeRow), e.previous_digest)) raise(e.note_id, Number(e.version) - 1, 'discrepancy', 'CONTENT_MISMATCH');
        }
    }
    for (const row of rows) {
        if (!inScope(row.note_id) || states.has(rowKey(row.note_id, row.version))) continue;
        const list = byNote.get(row.note_id) || [];
        const firstSealed = list.length ? Math.min(...list.map(e => Number(e.version))) : Infinity;
        const afterAdoption = cfg.adoptionAt && row.signed_at_text >= cfg.adoptionAt;
        if (Number(row.version) > firstSealed || afterAdoption)
            raise(row.note_id, row.version, cfg.keys.size ? 'discrepancy' : 'unavailable', cfg.keys.size ? 'UNREFERENCED_VERSION' : 'KEY_UNAVAILABLE');
        else raise(row.note_id, row.version, 'historical', null);
    }
    const notes = new Map();
    for (const s of states.values()) {
        if (!notes.has(s.note)) notes.set(s.note, { state: 'verified', code: null, versions: new Map() });
        const n = notes.get(s.note);
        n.versions.set(s.version, { state: s.state, code: s.code });
        if (RANK[s.state] > RANK[n.state]) { n.state = s.state; n.code = s.code; }
    }
    let state = 'verified';
    for (const n of notes.values()) if (RANK[n.state] > RANK[state]) state = n.state;
    for (const f of faults) if (RANK[f.state] > RANK[state]) state = f.state;
    // Hay referencia pero ninguna nota: el estado global no puede ser "verified" si falta la cadena.
    return { state, notes, faults };
}

// Calcula asiento y cabecera nuevos. La llamada debe ocurrir dentro de la transacción de la firma.
function seal({ cfg, row, previousDigest, head, now = new Date() }) {
    const sealedAt = now.toISOString().replace('T', ' ').replace('Z', '000');
    const entry = {
        id_business: row.id_business, id_person: row.id_person, seq: head ? Number(head.last_seq) + 1 : 1, note_id: row.note_id,
        version: Number(row.version), format: FORMAT, digest: digest(row), previous_digest: previousDigest || null,
        prev_mac: head ? head.last_mac : GENESIS, sealed_at_text: sealedAt, key_id: cfg.current.id
    };
    entry.mac = entryMac(cfg.current.key, entry);
    const nextHead = { id_business: row.id_business, id_person: row.id_person, last_seq: entry.seq, last_mac: entry.mac, key_id: cfg.current.id };
    nextHead.mac = headMac(cfg.current.key, nextHead);
    return { entry, head: nextHead };
}

async function persistSeal(db, transaction, { entry, head }) {
    try {
        await db.query(`INSERT INTO evolution_integrity_ledger (id_business,id_person,seq,note_id,version,format,digest,previous_digest,prev_mac,sealed_at,key_id,mac)
            VALUES (:id_business,:id_person,:seq,:note_id,:version,:format,:digest,:previous_digest,:prev_mac,:sealed_at_text,:key_id,:mac)`,
        { transaction, replacements: entry });
        await db.query(`INSERT INTO evolution_integrity_head (id_business,id_person,last_seq,last_mac,key_id,mac)
            VALUES (:id_business,:id_person,:last_seq,:last_mac,:key_id,:mac)
            ON DUPLICATE KEY UPDATE last_seq=VALUES(last_seq),last_mac=VALUES(last_mac),key_id=VALUES(key_id),mac=VALUES(mac)`,
        { transaction, replacements: head });
    } catch (error) { throw new IntegritySealError('SEAL_WRITE_FAILED', error); }
}

// ---- Evidencia operativa: solo identificadores y códigos, nunca texto clínico ----
const recent = new Map();
const logDir = () => path.resolve(process.env.EVOLUTION_INTEGRITY_LOG_DIR || 'logs');
async function append(file, line) {
    try {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.appendFile(file, JSON.stringify(line) + '\n', { mode: 0o600 });
        return true;
    } catch (error) { console.error('EVOLUTION_INTEGRITY_LOG_FAILED', error.code || error.message); return false; }
}
// Evento operativo. Repetir la misma discrepancia en 10 minutos no multiplica líneas.
async function recordEvent(event) {
    const id = [event.type, event.business, event.patient, event.note || '', event.version || '', event.code || ''].join('|');
    const now = Date.now();
    if (recent.has(id) && now - recent.get(id) < 600000) return false;
    recent.set(id, now);
    if (recent.size > 2000) recent.clear();
    console.warn('EVOLUTION_INTEGRITY', event.type, event.code || '', event.business, event.patient, event.note || '');
    return append(path.join(logDir(), 'evolution-integrity-events.jsonl'), { at: new Date().toISOString(), ...event });
}
// Ancla externa: cada sellado deja la cabecera para que la custodia separada pueda detectar una reversión completa.
function recordAnchor({ entry, head }) {
    const file = process.env.EVOLUTION_INTEGRITY_ANCHOR_PATH || path.join(logDir(), 'evolution-integrity-anchor.jsonl');
    return append(file, { at: new Date().toISOString(), business: entry.id_business, patient: entry.id_person, note: entry.note_id,
        version: entry.version, seq: entry.seq, entryMac: entry.mac, headMac: head.mac, keyId: entry.key_id });
}

module.exports = { FORMAT, GENESIS, ROW_SELECT, TEXT_TIME, IntegritySealError, stable, config, document, digest, entryMac, headMac,
    loadReference, verify, seal, persistSeal, recordEvent, recordAnchor, RANK };

'use strict';
// NC3/C22: cliente de la referencia externa («testigo»). El testigo es un servicio de solo-agregar, fuera de MySQL y
// del servidor de la aplicación, que guarda por cada sellado identificadores y evidencia de integridad (nunca texto
// clínico ni claves). La aplicación solo puede AGREGAR; Soporte/el conciliador son los únicos que leen.
const fs = require('node:fs');
const path = require('node:path');

function config(env = process.env) {
    const url = String(env.EVOLUTION_INTEGRITY_WITNESS_URL || '').replace(/\/+$/, '');
    return {
        enabled: Boolean(url && env.EVOLUTION_INTEGRITY_WITNESS_ENV),
        url, envId: env.EVOLUTION_INTEGRITY_WITNESS_ENV || '',
        writeToken: env.EVOLUTION_INTEGRITY_WITNESS_WRITE_TOKEN || '',
        supportToken: env.EVOLUTION_INTEGRITY_WITNESS_SUPPORT_TOKEN || '',
        spoolPath: env.EVOLUTION_INTEGRITY_WITNESS_SPOOL || path.join(path.resolve(env.EVOLUTION_INTEGRITY_LOG_DIR || 'logs'), 'evolution-integrity-witness-spool.jsonl'),
        timeoutMs: Number(env.EVOLUTION_INTEGRITY_WITNESS_TIMEOUT_MS) || 2000
    };
}

// Registro externo: lo mínimo para recomputar el MAC del asiento con la clave del servidor y localizar la nota.
function record(cfg, { entry, head }) {
    return {
        env: cfg.envId, business: entry.id_business, patient: entry.id_person, seq: Number(entry.seq), note: entry.note_id,
        version: Number(entry.version), format: entry.format, digest: entry.digest, previousDigest: entry.previous_digest || null,
        prevMac: entry.prev_mac, sealedAt: entry.sealed_at_text, keyId: entry.key_id, mac: entry.mac, headMac: head.mac
    };
}

async function call(cfg, method, route, token, body) {
    const response = await fetch(cfg.url + route, {
        method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutMs)
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { status: response.status, data };
}

// La cola local (spool) conserva con fsync lo que no pudo entregarse. Es un respaldo de entrega, no la referencia:
// si el servidor de la aplicación se restaura, lo que no llegó al testigo se pierde (ver límites en el reporte).
function spoolAppend(cfg, rec) {
    fs.mkdirSync(path.dirname(cfg.spoolPath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(cfg.spoolPath, 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify(rec) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function spoolRead(cfg) {
    try { return fs.readFileSync(cfg.spoolPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
}

const sending = new Set();
// Entrega al testigo antes de responder al profesional. Si falla, queda en la cola y se reintenta.
async function publish(cfg, sealed) {
    if (!cfg.enabled) return { state: 'disabled' };
    const rec = record(cfg, sealed);
    try {
        const result = await call(cfg, 'POST', '/v1/anchors', cfg.writeToken, rec);
        if ([200, 201].includes(result.status)) return { state: 'recorded' };
        if (result.status === 409) return { state: 'conflict' };
        throw new Error('WITNESS_HTTP_' + result.status);
    } catch (error) {
        try { spoolAppend(cfg, rec); } catch (spoolError) { console.error('EVOLUTION_INTEGRITY_SPOOL_FAILED', spoolError.code || spoolError.message); return { state: 'lost' }; }
        console.warn('EVOLUTION_INTEGRITY_WITNESS_PENDING', rec.business, rec.patient, rec.seq, error.code || error.message);
        return { state: 'pending' };
    }
}

// Reintenta la cola. Es idempotente en el testigo, así que un reinicio o una entrega duplicada no crean registros nuevos.
async function flush(cfg) {
    if (!cfg.enabled || sending.has(cfg.spoolPath)) return { sent: 0, left: 0 };
    sending.add(cfg.spoolPath);
    try {
        const items = spoolRead(cfg), left = [];
        if (!items.length) return { sent: 0, left: 0 };
        let sent = 0;
        for (const item of items) {
            try {
                const result = await call(cfg, 'POST', '/v1/anchors', cfg.writeToken, item);
                if ([200, 201, 409].includes(result.status)) sent++; else left.push(item);
            } catch { left.push(item); }
        }
        fs.mkdirSync(path.dirname(cfg.spoolPath), { recursive: true, mode: 0o700 });
        const temp = cfg.spoolPath + '.tmp';
        fs.writeFileSync(temp, left.map(item => JSON.stringify(item) + '\n').join(''), { mode: 0o600 });
        fs.renameSync(temp, cfg.spoolPath);
        return { sent, left: left.length };
    } finally { sending.delete(cfg.spoolPath); }
}

const anchors = cfg => call(cfg, 'GET', '/v1/anchors', cfg.supportToken);
const incidents = cfg => call(cfg, 'GET', '/v1/incidents', cfg.supportToken);
const postIncident = (cfg, event) => call(cfg, 'POST', '/v1/incidents', cfg.supportToken, event);

module.exports = { config, record, publish, flush, spoolRead, anchors, incidents, postIncident };

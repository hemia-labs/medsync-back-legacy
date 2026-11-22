'use strict';
// NC3/C22: cliente de la referencia externa («testigo») y su cola durable.
// El testigo es un servicio de solo-agregar, fuera de MySQL y del servidor de la aplicación; guarda identificadores y MAC
// (nunca texto clínico ni claves). La aplicación solo puede AGREGAR; Soporte y el conciliador son los que leen.
//
// Cola durable (R2): al firmar, la fila de entrega se escribe en la MISMA transacción que la versión y su sello, así que
// «firmada» implica «encolada» sin intervalo entre ambos. Cada fila es una referencia con identidad estable
// (consultorio, paciente, nota, versión) y pasa de `pending` a `acked` solo cuando el testigo acusa recibo.
// Un acuse perdido o un reinicio solo provocan un reenvío; el testigo distingue el duplicado idéntico (200) del conflicto (409).
const { randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const integrity = require('./evolutionIntegrity.service');

const BASE_DELAY_MS = () => Number(process.env.EVOLUTION_INTEGRITY_DELIVERY_BACKOFF_MS) || 5000;
const MAX_DELAY_MS = 60000; // tope de la espera progresiva: tras recuperarse el testigo, el pendiente se resuelve en menos de un minuto

function config(env = process.env) {
    const url = String(env.EVOLUTION_INTEGRITY_WITNESS_URL || '').replace(/\/+$/, '');
    return {
        enabled: Boolean(url && env.EVOLUTION_INTEGRITY_WITNESS_ENV),
        url, envId: env.EVOLUTION_INTEGRITY_WITNESS_ENV || '',
        writeToken: env.EVOLUTION_INTEGRITY_WITNESS_WRITE_TOKEN || '',
        supportToken: env.EVOLUTION_INTEGRITY_WITNESS_SUPPORT_TOKEN || '',
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

// Alta en la cola. Se llama DENTRO de la transacción de la firma (o de la reparación de un reintento).
async function enqueue(db, transaction, { business, patient, note, version, seq }) {
    await db.query(`INSERT IGNORE INTO evolution_integrity_delivery (id_business,id_person,note_id,version,seq,state,attempts,queued_at,next_attempt_at)
        VALUES (:business,:patient,:note,:version,:seq,'pending',0,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))`,
    { transaction, replacements: { business, patient, note, version, seq } });
}

const headFor = (cfg, entry) => ({ mac: integrity.headMac(cfg.keys.get(entry.key_id), { id_business: entry.id_business, id_person: entry.id_person, last_seq: entry.seq, last_mac: entry.mac, key_id: entry.key_id }) });

// Entrega pendientes. Reclama filas con un token y plazo (varios procesos no se pisan), envía en orden de cadena por
// paciente y se detiene en el primer fallo de ese paciente. `force` ignora la espera progresiva (la firma recién hecha).
// `only` limita el intento a una referencia concreta (la de la operación en curso) y solo si es la elegible: si hay una
// anterior del mismo paciente sin acuse, no se salta el orden ni se espera por un lote: la entrega queda al despachador.
async function deliver(db, cfg, { business = null, patient = null, force = false, limit = 50, only = null } = {}) {
    if (!cfg.enabled) return { sent: 0, failed: 0, pending: 0 };
    if (only) {
        const [earlier] = await db.query(`SELECT 1 AS b FROM evolution_integrity_delivery d JOIN evolution_integrity_delivery t ON t.id_business=d.id_business AND t.id_person=d.id_person
            WHERE t.id_business=:business AND t.id_person=:patient AND t.note_id=:note AND t.version=:version AND d.state='pending' AND d.seq < t.seq LIMIT 1`,
        { replacements: { business, patient, note: only.note, version: only.version }, type: QueryTypes.SELECT });
        if (earlier) return { sent: 0, failed: 0, pending: 1, skipped: 'EARLIER_PENDING' };
    }
    const keys = integrity.config().keys;
    const token = randomUUID();
    const scope = (business ? ' AND id_business=:business AND id_person=:patient' : '') + (only ? ' AND note_id=:note AND version=:version' : '');
    await db.query(`UPDATE evolution_integrity_delivery SET claim_token=:token, claimed_until=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 30 SECOND)
        WHERE state='pending' AND (claimed_until IS NULL OR claimed_until<UTC_TIMESTAMP(6))${force ? '' : ' AND next_attempt_at<=UTC_TIMESTAMP(6)'}${scope}
        ORDER BY id_business,id_person,seq LIMIT ${Number(limit)}`, { replacements: { token, business, patient, note: only && only.note, version: only && only.version } });
    const rows = await db.query('SELECT * FROM evolution_integrity_delivery WHERE claim_token=:token ORDER BY id_business,id_person,seq', { replacements: { token }, type: QueryTypes.SELECT });
    const stopped = new Set();
    let sent = 0, failed = 0;
    // Orden de la cadena: si el mismo paciente tiene una referencia anterior pendiente que NO está en este lote (en vuelo por otro
    // proceso o en espera programada de reintento), las posteriores no se adelantan.
    const waiting = new Set();
    for (const row of rows) {
        const who = row.id_business + '|' + row.id_person;
        if (waiting.has(who) || stopped.has(who)) continue;
        const [blocker] = await db.query(`SELECT 1 AS b FROM evolution_integrity_delivery WHERE id_business=:b AND id_person=:p AND state='pending' AND seq < :s
            AND (claim_token IS NULL OR claim_token<>:token) LIMIT 1`, { replacements: { b: row.id_business, p: row.id_person, s: row.seq, token }, type: QueryTypes.SELECT });
        if (blocker) waiting.add(who);
    }
    for (const row of rows) {
        const who = row.id_business + '|' + row.id_person;
        const release = (state, error) => db.query(`UPDATE evolution_integrity_delivery SET state=:state, attempts=attempts+1, last_attempt_at=UTC_TIMESTAMP(6),
            acked_at=${state === 'acked' ? 'UTC_TIMESTAMP(6)' : 'acked_at'}, last_error=:error, claim_token=NULL, claimed_until=NULL,
            next_attempt_at=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL :delay MICROSECOND)
            WHERE id_business=:b AND id_person=:p AND note_id=:n AND version=:v AND claim_token=:token`,
        { replacements: { state, error: error || null, b: row.id_business, p: row.id_person, n: row.note_id, v: row.version, token,
            delay: Math.min(MAX_DELAY_MS, BASE_DELAY_MS() * 2 ** Math.min(row.attempts, 10)) * 1000 } });
        if (waiting.has(who)) {
            await db.query('UPDATE evolution_integrity_delivery SET claim_token=NULL, claimed_until=NULL WHERE id_business=:b AND id_person=:p AND note_id=:n AND version=:v AND claim_token=:token',
                { replacements: { b: row.id_business, p: row.id_person, n: row.note_id, v: row.version, token } });
            continue;
        }
        if (stopped.has(who)) { await release('pending', 'ORDER_WAIT'); failed++; continue; }
        try {
            const [entry] = await db.query(`SELECT *, DATE_FORMAT(sealed_at,'${integrity.TEXT_TIME}') AS sealed_at_text FROM evolution_integrity_ledger
                WHERE id_business=:b AND id_person=:p AND seq=:s`, { replacements: { b: row.id_business, p: row.id_person, s: row.seq }, type: QueryTypes.SELECT });
            if (!entry || !keys.get(entry.key_id)) throw new Error(entry ? 'KEY_UNAVAILABLE' : 'LEDGER_ENTRY_MISSING');
            const result = await call(cfg, 'POST', '/v1/anchors', cfg.writeToken, record(cfg, { entry, head: headFor({ keys }, entry) }));
            if ([200, 201].includes(result.status)) { await release('acked'); sent++; }
            else if (result.status === 409) { await release('conflict', 'WITNESS_CONFLICT'); failed++; }
            else throw new Error('HTTP_' + result.status);
        } catch (error) {
            stopped.add(who); failed++;
            await release('pending', String(error.code || error.message).slice(0, 40));
        }
    }
    return { sent, failed, pending: failed };
}

// Estado externo de una versión (para la respuesta de la firma, el reintento y las lecturas).
async function stateOf(db, { business, patient, note, version }, transaction) {
    const [row] = await db.query('SELECT state FROM evolution_integrity_delivery WHERE id_business=:business AND id_person=:patient AND note_id=:note AND version=:version',
        { replacements: { business, patient, note, version }, type: QueryTypes.SELECT, transaction });
    return row ? row.state : null;
}
// `ok:false` cuando la cola no se puede leer: la lectura lo muestra como «desconocido», nunca como recibido.
async function readStates(db, { business, patient, note = null }, transaction) {
    try { return { ok: true, states: await statesFor(db, { business, patient, note }, transaction) }; }
    catch (error) { console.error('EVOLUTION_INTEGRITY_DELIVERY_UNREADABLE', error.code || error.message); return { ok: false, states: new Map() }; }
}
async function statesFor(db, { business, patient, note = null }, transaction) {
    const rows = await db.query(`SELECT note_id, version, state FROM evolution_integrity_delivery WHERE id_business=:business AND id_person=:patient${note ? ' AND note_id=:note' : ''}`,
        { replacements: { business, patient, note }, type: QueryTypes.SELECT, transaction });
    return new Map(rows.map(r => [r.note_id + '#' + r.version, r.state]));
}

const anchors = cfg => call(cfg, 'GET', '/v1/anchors', cfg.supportToken);
const incidents = cfg => call(cfg, 'GET', '/v1/incidents', cfg.supportToken);
const postIncident = (cfg, event) => call(cfg, 'POST', '/v1/incidents', cfg.supportToken, event);

module.exports = { config, record, enqueue, deliver, stateOf, statesFor, readStates, anchors, incidents, postIncident, headFor };

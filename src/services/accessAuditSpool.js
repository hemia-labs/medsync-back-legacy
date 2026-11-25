'use strict';
// NC2: respaldo durable de eventos de lectura clínica (decisión del operador, 2026-11-25).
//
// Una lectura autorizada de historia o del detalle de receta registra su evento en la bitácora de MySQL. Si esa escritura
// falla, el evento se guarda en un archivo propio del servidor (escritura temporal + fsync + rename + fsync del directorio)
// ANTES de entregar el contenido. Si tampoco se puede guardar en disco, la lectura se bloquea como hasta ahora.
// La preparación de salidas (imprimir, descargar, PDF) no usa este respaldo: sigue cerrando.
//
// Cada acceso es un archivo con identificador estable, actor, consultorio, recurso, operación y hora original. Al recuperarse
// la bitácora, el vaciado inserta cada acceso con ese mismo identificador y hora; una clave duplicada significa que ya estaba
// insertado, de modo que cada acceso aparece una sola vez aunque el vaciado se repita o se interrumpa.
//
// El aviso a Soporte reutiliza la cola de incidentes de NC3/C22 (createOutbox) y su canal (línea estructurada + webhook):
// un incidente por avería (familia de bitácora + código de error) y ciclo, no uno por acceso. Si el aviso falla, la lectura ya
// respaldada continúa y el aviso se reintenta con espera progresiva. Ni la cola ni el aviso guardan texto clínico.
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { QueryTypes } = require('sequelize');
const { createOutbox } = require('./evolutionIntegrityIncidentOutbox');

const ACTION = 'Soporte de HEMIA: revisar la bitácora de accesos de MySQL. Los accesos están respaldados en el servidor y se insertarán al recuperarse.';

// Escritores por familia. Solo columnas de trazabilidad: identificadores, operación, contexto y estado de la receta.
const KINDS = {
    clinical_history_view: {
        table: 'clinical_history_events',
        write: (db, e, transaction) => db.query(
            `INSERT INTO clinical_history_events (id_clinical_history_event, clinical_history_id, business_id, patient_id, event_type, user_id, metadata_json, created_at)
             VALUES (:id, :resource, :business, :patient, 'VIEWED', :actor, :metadata, :at)`,
            { replacements: { id: e.id, resource: e.resource, business: e.business, patient: e.patient, actor: e.actor || null, metadata: JSON.stringify({ context: e.context }), at: new Date(e.at) }, type: QueryTypes.INSERT, transaction })
    },
    prescription_view: {
        table: 'prescription_audit_log',
        write: (db, e, transaction) => db.query(
            `INSERT INTO prescription_audit_log (id_prescription_audit_log, id_business, id_prescription, id_user, action, previous_status, new_status, reason, metadata, created_at)
             VALUES (:id, :business, :resource, :actor, 'viewed', :status, :status, NULL, :metadata, :at)`,
            { replacements: { id: e.id, business: e.business, resource: e.resource, actor: e.actor || null, status: e.status || null, metadata: JSON.stringify({ context: e.context }), at: new Date(e.at) }, type: QueryTypes.INSERT, transaction })
    }
};

const errorCode = error => String((error && (error.original?.code || error.parent?.code || error.code || error.name)) || 'UNKNOWN').slice(0, 40);
const isDuplicate = error => (error && (error.original?.errno === 1062 || error.parent?.errno === 1062 || error.name === 'SequelizeUniqueConstraintError'));

// Mismo canal que NC3/C22: línea estructurada y, si hay webhook, POST JSON. Sin webhook el aviso NO se da por entregado.
async function defaultAlert(incident, attempt) {
    console.error('NC2_ACCESS_AUDIT_INCIDENT ' + JSON.stringify({ ...incident, attempt }));
    const url = process.env.ACCESS_AUDIT_ALERT_WEBHOOK_URL || process.env.EVOLUTION_INTEGRITY_ALERT_WEBHOOK_URL;
    if (!url) return { ok: false, channel: 'log_only' };
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...incident, attempt }), signal: AbortSignal.timeout(3000) });
        return { ok: r.ok, channel: 'webhook', status: r.status };
    } catch (error) { return { ok: false, channel: 'webhook', error: String(error.code || error.name).slice(0, 30) }; }
}

function createAccessAuditSpool({ dir = path.resolve(process.env.ACCESS_AUDIT_SPOOL_DIR || path.join('logs', 'access-audit-spool')),
    db = () => require('../db/Sequelize.connection'), alert = defaultAlert, now = () => Date.now(),
    env = process.env.ACCESS_AUDIT_ENV || process.env.EVOLUTION_INTEGRITY_WITNESS_ENV || process.env.NODE_ENV || 'local',
    alertBackoffMs = Number(process.env.ACCESS_AUDIT_ALERT_BACKOFF_MS) || 30000 } = {}) {
    const pendingDir = path.join(dir, 'pending');
    const outbox = createOutbox(path.join(dir, 'alerts', 'outbox.json'));
    const database = () => (typeof db === 'function' ? db() : db);
    const backoff = n => Math.min(15 * 60000, alertBackoffMs * 2 ** Math.min(n, 10));
    const incidentId = (table, code) => 'NC2-ACCESS-' + createHash('sha256').update([env, table, code].join('|')).digest('hex').slice(0, 12);
    const pending = () => { try { return fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

    function persist(event) {
        fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
        const name = `${event.at.replace(/[-:.TZ]/g, '')}-${event.id}.json`;
        const temp = path.join(pendingDir, name + '.tmp');
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeSync(fd, JSON.stringify(event)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, path.join(pendingDir, name));
        // fsync del directorio para que el rename sobreviva a un corte; Windows no permite abrir directorios.
        try { const d = fs.openSync(pendingDir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (error) { if (process.platform !== 'win32') throw error; }
    }

    // Un incidente por avería: familia + código. Un ciclo nuevo sólo cuando el anterior quedó resuelto por el vaciado.
    function openOutage(table, code) {
        const id = incidentId(table, code);
        const prior = outbox.latest(id);
        if (prior && !prior.cleared) return prior;
        return outbox.put({
            id, cycle: (prior ? prior.cycle : 0) + 1, cleared: false, delivered: false,
            incident: { id, env, code: 'ACCESS_AUDIT_SPOOLED', table, error: code, detectedAt: new Date(now()).toISOString(), action: ACTION },
            attempts: [], nextAttemptAt: now()
        });
    }

    let dispatching = null;
    function deliverAlerts() {
        if (dispatching) return dispatching;
        dispatching = (async () => {
            const out = [];
            for (const entry of outbox.all()) {
                if (entry.delivered || now() < (entry.nextAttemptAt ?? 0)) continue;
                const queued = pending().length;
                const result = await alert({ ...entry.incident, cycle: entry.cycle, pendingAccesses: queued }, entry.attempts.length + 1)
                    .catch(error => ({ ok: false, channel: 'unknown', error: String(error.message).slice(0, 30) }));
                entry.attempts.push({ at: new Date(now()).toISOString(), channel: result.channel, ok: Boolean(result.ok), ...(result.status ? { status: result.status } : {}), ...(result.error ? { error: result.error } : {}) });
                if (result.ok) { entry.delivered = true; entry.deliveredAt = new Date(now()).toISOString(); entry.nextAttemptAt = null; }
                else entry.nextAttemptAt = now() + backoff(entry.attempts.length);
                outbox.put(entry);
                out.push({ id: entry.id, cycle: entry.cycle, attempt: entry.attempts.length, ok: Boolean(result.ok), channel: result.channel });
            }
            return out;
        })().finally(() => { dispatching = null; });
        return dispatching;
    }

    // Registra la lectura. Devuelve sólo si el evento quedó en la bitácora o respaldado en disco; si no, relanza el error original.
    async function record(kind, fields, transaction = null) {
        const writer = KINDS[kind];
        if (!writer) throw new Error('ACCESS_AUDIT_KIND_UNKNOWN');
        const at = new Date(Math.floor(now() / 1000) * 1000).toISOString(); // DATETIME sin fracciones: se fija al segundo
        const event = { v: 1, id: randomUUID(), kind, at, actor: fields.actor || null, business: fields.business, resource: fields.resource,
            ...(fields.patient ? { patient: fields.patient } : {}), context: fields.context, ...(fields.status ? { status: fields.status } : {}) };
        try {
            await writer.write(database(), event, transaction);
            return { stored: 'log', id: event.id };
        } catch (error) {
            const code = errorCode(error);
            try { persist({ ...event, failure: code }); }
            catch (spoolError) {
                console.error('NC2_ACCESS_AUDIT_SPOOL_FAILED ' + JSON.stringify({ kind, table: writer.table, error: code, spool: errorCode(spoolError) }));
                throw error;
            }
            try { openOutage(writer.table, code); }
            catch (alertError) { console.error('NC2_ACCESS_AUDIT_ALERT_QUEUE_FAILED ' + JSON.stringify({ table: writer.table, error: errorCode(alertError) })); }
            deliverAlerts().catch(() => null);
            return { stored: 'spool', id: event.id };
        }
    }

    // Vacía el respaldo hacia la bitácora. Una familia que sigue fallando se deja para el siguiente ciclo.
    let draining = null;
    function drain() {
        if (draining) return draining;
        draining = (async () => {
            const blocked = new Map(), result = { inserted: 0, duplicates: 0, pending: 0 };
            for (const name of pending()) {
                const file = path.join(pendingDir, name);
                let event;
                try { event = JSON.parse(fs.readFileSync(file, 'utf8')); }
                catch (error) {
                    fs.renameSync(file, file + '.unreadable');
                    console.error('NC2_ACCESS_AUDIT_SPOOL_UNREADABLE ' + JSON.stringify({ file: name, error: errorCode(error) }));
                    try { openOutage('spool', 'ENTRY_UNREADABLE'); } catch { /* el registro del servidor queda como respaldo */ }
                    continue;
                }
                const writer = KINDS[event.kind];
                if (!writer || blocked.has(writer.table)) { result.pending++; continue; }
                try { await writer.write(database(), event); result.inserted++; }
                catch (error) {
                    if (!isDuplicate(error)) { blocked.set(writer.table, errorCode(error)); result.pending++; continue; }
                    result.duplicates++;
                }
                fs.unlinkSync(file);
            }
            // Avería resuelta cuando su familia ya no tiene accesos pendientes; si los hay sin incidente abierto, se abre.
            const left = new Map();
            for (const name of pending()) {
                try { const e = JSON.parse(fs.readFileSync(path.join(pendingDir, name), 'utf8')); const t = KINDS[e.kind] && KINDS[e.kind].table; if (t) left.set(t, blocked.get(t) || e.failure || 'UNKNOWN'); } catch { /* se trata en el siguiente vaciado */ }
            }
            for (const entry of outbox.all()) {
                if (entry.cleared || entry.incident.table === 'spool' || left.has(entry.incident.table)) continue;
                entry.cleared = true; entry.clearedAt = new Date(now()).toISOString(); outbox.put(entry);
            }
            for (const [table, code] of left) {
                if (!outbox.all().some(e => e.incident.table === table && !e.cleared)) openOutage(table, code);
            }
            result.alerts = await deliverAlerts();
            return result;
        })().finally(() => { draining = null; });
        return draining;
    }

    let timer = null;
    return {
        record, drain, deliverAlerts, pending, dir,
        outages: () => outbox.all(),
        start(intervalMs = 30000) {
            if (timer) return true;
            if (!outbox.acquire()) { console.error('NC2_ACCESS_AUDIT_DRAIN_ALREADY_RUNNING'); return false; }
            timer = setInterval(() => { drain().catch(error => console.error('NC2_ACCESS_AUDIT_DRAIN_ERROR ' + errorCode(error))); }, Math.max(500, Number(intervalMs)));
            timer.unref();
            drain().catch(error => console.error('NC2_ACCESS_AUDIT_DRAIN_ERROR ' + errorCode(error)));
            return true;
        },
        stop() { if (timer) clearInterval(timer); timer = null; outbox.release(); }
    };
}

let shared = null;
module.exports = {
    createAccessAuditSpool, KINDS, ACTION,
    shared: () => (shared || (shared = createAccessAuditSpool())),
    install(instance) { shared = instance; return instance; },
    record: (kind, fields, transaction) => module.exports.shared().record(kind, fields, transaction)
};

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
// El aviso a Soporte sigue el modelo de la cola de incidentes de NC3/C22 (entrada por ciclo, despachador único con el bloqueo de
// createOutbox) y su canal (línea estructurada + webhook), pero guarda sus entradas con el escritor completo de este módulo:
// un incidente por avería (familia de bitácora + código de error) y ciclo, no uno por acceso. Si el aviso falla, la lectura ya
// respaldada continúa y el aviso se reintenta con espera progresiva. Ni la cola ni el aviso guardan texto clínico.
// Contrato del receptor de Soporte (el mismo de C22): referencia `INC-` + 12 hexadecimales, ciclo entero, ambiente y un código
// reconocido. NC2 usa el código ACCESS_AUDIT_SPOOLED, que el receptor debe aceptar de forma explícita.
// El vaciado no retira el archivo de un acceso hasta que el aviso de su avería está completo en disco (releído) o tiene acuse.
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

// Escritura durable: todos los bytes, fsync, rename y fsync del directorio. Si algo falla se borra el temporal y el archivo
// anterior queda intacto (nunca se publica un archivo incompleto).
function writeDurable(dir, name, text) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, name + '.tmp');
    const data = Buffer.from(text, 'utf8');
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
        // writeSync puede escribir menos bytes de los pedidos: se completa antes de sincronizar y publicar.
        for (let offset = 0; offset < data.length;) {
            const written = fs.writeSync(fd, data, offset, data.length - offset);
            if (!(written > 0)) throw Object.assign(new Error('ACCESS_AUDIT_SHORT_WRITE'), { code: 'ESHORTWRITE' });
            offset += written;
        }
        fs.fsyncSync(fd);
    } catch (error) {
        try { fs.closeSync(fd); } catch { /* ya cerrado */ }
        try { fs.unlinkSync(temp); } catch { /* sin temporal incompleto */ }
        throw error;
    }
    fs.closeSync(fd);
    fs.renameSync(temp, path.join(dir, name));
    // fsync del directorio para que el rename sobreviva a un corte; Windows no permite abrir directorios.
    try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (error) { if (process.platform !== 'win32') throw error; }
}

// Avisos de NC2: una entrada por incidente y ciclo. put deja la entrada en memoria antes de guardar; si el guardado falla, la
// entrada sigue ahí y el siguiente guardado la vuelve a escribir. Un archivo ilegible se aparta (no se sobrescribe).
function createAlertStore(file) {
    const entries = new Map(), keyOf = e => e.id + '#' + (e.cycle || 1);
    try { for (const e of JSON.parse(fs.readFileSync(file, 'utf8'))) entries.set(keyOf(e), e); }
    catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('NC2_ACCESS_AUDIT_ALERTS_UNREADABLE ' + JSON.stringify({ error: String(error.code || error.name).slice(0, 40) }));
            try { fs.renameSync(file, file + '.unreadable-' + Date.now()); } catch { /* se conserva donde está */ }
        }
    }
    const save = () => writeDurable(path.dirname(file), path.basename(file), JSON.stringify([...entries.values()], null, 1));
    return {
        latest: id => [...entries.values()].filter(e => e.id === id).sort((a, b) => b.cycle - a.cycle)[0],
        all: () => [...entries.values()],
        put(entry) { entries.set(keyOf(entry), entry); save(); return entry; },
        save
    };
}

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
    const outboxFile = path.join(dir, 'alerts', 'outbox.json');
    const outbox = createAlertStore(outboxFile);
    const dispatcherLock = createOutbox(path.join(dir, 'alerts', 'dispatcher.json')); // sólo su bloqueo de despachador único
    const database = () => (typeof db === 'function' ? db() : db);
    const backoff = n => Math.min(15 * 60000, alertBackoffMs * 2 ** Math.min(n, 10));
    // Mismo formato de referencia que C22; 'nc2-access' en el resumen separa el espacio de nombres de sus incidentes.
    const incidentId = (table, code) => 'INC-' + createHash('sha256').update(['nc2-access', env, table, code].join('|')).digest('hex').slice(0, 12);
    const pending = () => { try { return fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

    function persist(event) {
        writeDurable(pendingDir, `${event.at.replace(/[-:.TZ]/g, '')}-${event.id}.json`, JSON.stringify(event));
    }

    // Un incidente por avería: familia + código. En vivo (sin at) se abre un ciclo nuevo si el anterior ya quedó resuelto.
    // En el vaciado (con at, la hora del acceso al segundo) un ciclo resuelto sólo cubre el acceso si éste ocurrió en un segundo
    // estrictamente anterior a la resolución; ante la duda se abre un ciclo nuevo (un aviso de más, nunca uno de menos).
    // Con at, la detección es la hora del acceso que reveló la avería (reconstrucción tras un reinicio).
    function openOutage(table, code, at = null) {
        const id = incidentId(table, code);
        const prior = outbox.latest(id);
        if (prior && !prior.cleared) return prior;
        if (prior && at && Date.parse(at) >= Date.parse(prior.incident.detectedAt) - 1000
            && Date.parse(at) < Math.floor(Date.parse(prior.clearedAt) / 1000) * 1000) return prior;
        return outbox.put({
            id, cycle: (prior ? prior.cycle : 0) + 1, cleared: false, delivered: false,
            incident: { id, env, code: 'ACCESS_AUDIT_SPOOLED', table, error: code, detectedAt: at || new Date(now()).toISOString(), action: ACTION },
            attempts: [], nextAttemptAt: now()
        });
    }

    // Copia en disco de un ciclo de aviso. Se relee el archivo completo: si la escritura quedó incompleta (bytes de menos), el
    // JSON no se puede leer y el aviso no cuenta como guardado.
    function persistedCopy(entry) {
        try { return JSON.parse(fs.readFileSync(outboxFile, 'utf8')).find(e => e.id === entry.id && e.cycle === entry.cycle) || null; }
        catch { return null; }
    }

    // Antes de retirar la evidencia de un acceso: el aviso de su avería debe estar completo en disco o tener acuse del receptor.
    // Una entrada que sólo existe en memoria (porque falló o quedó incompleta su escritura) se vuelve a guardar aquí.
    function ensureAlertDurable(table, code, at) {
        let entry;
        try { entry = openOutage(table, code, at); }
        catch (error) { entry = outbox.latest(incidentId(table, code)); if (!entry) throw error; } // quedó en memoria: se reintenta
        if (persistedCopy(entry)) return entry;
        try { outbox.save(); } catch { /* se comprueba abajo */ }
        if (persistedCopy(entry) || entry.delivered) return entry; // delivered: acuse del receptor, que guarda su propio comprobante
        throw Object.assign(new Error('ACCESS_AUDIT_ALERT_NOT_DURABLE'), { code: 'ENOTDURABLE' });
    }

    // Guarda una entrada de aviso; si falla, queda en memoria y se reintentará en el siguiente guardado.
    function saveEntry(entry) {
        try { outbox.put(entry); }
        catch (error) { console.error('NC2_ACCESS_AUDIT_ALERT_QUEUE_FAILED ' + JSON.stringify({ table: entry.incident.table, error: errorCode(error) })); }
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
                saveEntry(entry);
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
                // El aviso de la avería queda completo en disco (o con acuse) antes de retirar la evidencia; si no, el archivo se queda.
                try { ensureAlertDurable(writer.table, event.failure || 'UNKNOWN', event.at); }
                catch (error) {
                    console.error('NC2_ACCESS_AUDIT_ALERT_QUEUE_FAILED ' + JSON.stringify({ table: writer.table, error: errorCode(error) }));
                    result.pending++; continue;
                }
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
                entry.cleared = true; entry.clearedAt = new Date(now()).toISOString(); saveEntry(entry);
            }
            for (const [table, code] of left) {
                if (!outbox.all().some(e => e.incident.table === table && !e.cleared)) {
                    try { openOutage(table, code); } catch (error) { console.error('NC2_ACCESS_AUDIT_ALERT_QUEUE_FAILED ' + JSON.stringify({ table, error: errorCode(error) })); }
                }
            }
            result.alerts = await deliverAlerts();
            return result;
        })().finally(() => { draining = null; });
        return draining;
    }

    let timer = null, retryTimer = null;
    // Arranque del vaciado: nunca lanza. Si el respaldo no está disponible lo comunica y reintenta; la API sigue en pie y las
    // lecturas siguen registrándose en MySQL (sólo se bloquean si también falla la bitácora).
    function start(intervalMs = 30000, { retryMs = Number(process.env.ACCESS_AUDIT_START_RETRY_MS) || 60000 } = {}) {
        if (timer) return true;
        let acquired;
        try { acquired = dispatcherLock.acquire(); }
        catch (error) {
            console.error('NC2_ACCESS_AUDIT_SPOOL_UNAVAILABLE ' + JSON.stringify({ error: errorCode(error), retryMs }));
            if (!retryTimer) { retryTimer = setTimeout(() => { retryTimer = null; start(intervalMs, { retryMs }); }, Math.max(100, retryMs)); retryTimer.unref(); }
            return false;
        }
        {
            if (!acquired) { console.error('NC2_ACCESS_AUDIT_DRAIN_ALREADY_RUNNING'); return false; }
            timer = setInterval(() => { drain().catch(error => console.error('NC2_ACCESS_AUDIT_DRAIN_ERROR ' + errorCode(error))); }, Math.max(500, Number(intervalMs)));
            timer.unref();
            drain().catch(error => console.error('NC2_ACCESS_AUDIT_DRAIN_ERROR ' + errorCode(error)));
            return true;
        }
    }
    return {
        record, drain, deliverAlerts, pending, dir, start,
        running: () => Boolean(timer),
        outages: () => outbox.all(),
        stop() { if (timer) clearInterval(timer); if (retryTimer) clearTimeout(retryTimer); timer = retryTimer = null; dispatcherLock.release(); }
    };
}

let shared = null;
module.exports = {
    createAccessAuditSpool, KINDS, ACTION,
    shared: () => (shared || (shared = createAccessAuditSpool())),
    install(instance) { shared = instance; return instance; },
    // Arranque desde src/index.js: un fallo del respaldo nunca se confunde con la indisponibilidad de MySQL ni cierra la API.
    startWorker(intervalMs) {
        try { return module.exports.shared().start(intervalMs); }
        catch (error) { console.error('NC2_ACCESS_AUDIT_SPOOL_UNAVAILABLE ' + JSON.stringify({ error: errorCode(error) })); return false; }
    },
    record: (kind, fields, transaction) => module.exports.shared().record(kind, fields, transaction)
};

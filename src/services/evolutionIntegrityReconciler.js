'use strict';
// NC3/C22: conciliador. Compara las cabeceras de integridad de MySQL con la referencia externa (testigo) y avisa a
// Soporte aunque nadie abra el expediente. Distingue:
//   - ROLLBACK_SUSPECTED / HISTORY_DIVERGED / WITNESS_RECORD_INVALID: discrepancia confirmada (el testigo es autoritativo).
//   - REFERENCE_STALE / REFERENCE_UNVERIFIABLE: el testigo va atrasado respecto de MySQL (advertencia).
//   - REFERENCE_UNREACHABLE: no se pudo consultar el testigo (advertencia; nunca se declara discrepancia por eso).
// El testigo nunca se sobrescribe con el estado de MySQL: solo se extiende si MySQL continúa exactamente su último registro.
//
// R2: los incidentes pasan por una cola durable (archivo del servidor, fuera de MySQL). El aviso a Soporte se reintenta con
// espera progresiva y la MISMA referencia hasta obtener acuse del canal, aunque el testigo y el canal fallen a la vez o el
// conciliador se reinicie. Cada intento queda registrado (hora, canal, resultado) sin texto clínico.
const { createHash } = require('node:crypto');
const path = require('node:path');
const { QueryTypes } = require('sequelize');
const integrity = require('./evolutionIntegrity.service');
const witness = require('./evolutionIntegrityWitness.service');
const { createOutbox } = require('./evolutionIntegrityIncidentOutbox');

const ACTION = 'Soporte de HEMIA: confirmar con el responsable del consultorio, conservar evidencia y coordinar la recuperación en un entorno aislado.';

// Canal de Soporte: línea estructurada (sin texto clínico) y, si está configurado, webhook JSON. Sin webhook la entrega
// NO se da por hecha: queda `log_only` y el incidente sigue pendiente de acuse.
async function defaultAlert(incident, attempt) {
    console.error('NC3_INTEGRITY_INCIDENT ' + JSON.stringify({ ...incident, attempt }));
    const url = process.env.EVOLUTION_INTEGRITY_ALERT_WEBHOOK_URL;
    if (!url) return { ok: false, channel: 'log_only' };
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...incident, attempt }), signal: AbortSignal.timeout(3000) });
        return { ok: r.ok, channel: 'webhook', status: r.status };
    } catch (error) { return { ok: false, channel: 'webhook', error: String(error.code || error.name).slice(0, 30) }; }
}

function createReconciler({ db, witnessCfg = witness.config(), alert = defaultAlert, now = () => Date.now(), staleMs = 15 * 60000, unreachableAfter = 3,
    outboxFile = process.env.EVOLUTION_INTEGRITY_INCIDENT_OUTBOX || path.join(path.resolve(process.env.EVOLUTION_INTEGRITY_LOG_DIR || 'logs'), 'evolution-integrity-incident-outbox.json'),
    alertBackoffMs = Number(process.env.EVOLUTION_INTEGRITY_ALERT_BACKOFF_MS) || 30000 }) {
    const outbox = createOutbox(outboxFile);
    const active = new Map();      // business|patient -> [{code,id}] condiciones vigentes (alimenta el aviso de lectura)
    let failures = 0, running = false, retrying = false, timer = null, retryTimer = null, last = null;
    const idOf = (business, patient, code) => 'INC-' + createHash('sha256').update([witnessCfg.envId, business, patient, code].join('|')).digest('hex').slice(0, 12);
    const iso = () => new Date(now()).toISOString();
    const backoff = n => Math.min(15 * 60000, alertBackoffMs * 2 ** Math.min(n, 10));

    async function incidentState() {
        const res = await witness.incidents(witnessCfg);
        const state = new Map();
        for (const e of res.data.events || []) {
            const cur = state.get(e.id) || { state: null, delivered: false };
            if (e.type === 'open') state.set(e.id, { state: 'open', delivered: false });
            else if (e.type === 'delivered') state.set(e.id, { ...cur, delivered: true });
            else if (e.type === 'cleared' || e.type === 'closed') state.set(e.id, { state: e.type, delivered: cur.delivered });
        }
        return state;
    }

    // Un incidente lógico por consultorio, paciente y código. Se crea una vez por ciclo (abierto → resuelto).
    function ensure(found, known) {
        const id = idOf(found.business, found.patient, found.code);
        if (found.business !== '*') (active.get(found.business + '|' + found.patient) || active.set(found.business + '|' + found.patient, []).get(found.business + '|' + found.patient)).push({ code: found.code, id, severity: found.severity });
        else (active.get('*|*') || active.set('*|*', []).get('*|*')).push({ code: found.code, id, severity: found.severity });
        const prior = outbox.latest(id);
        if (prior && !prior.cleared) return prior;
        const witnessSeen = known && known.get(id);
        const entry = {
            id, cycle: (prior ? prior.cycle : 0) + 1, // un ciclo nuevo es una entrada aparte: no pisa uno anterior pendiente de entrega
            cleared: false, delivered: false, witnessOpen: false, witnessDelivered: false, witnessCleared: false,
            incident: { id, env: witnessCfg.envId, code: found.code, severity: found.severity, business: found.business, patient: found.patient, note: found.note || null,
                witnessSeq: found.witnessSeq ?? null, databaseSeq: found.databaseSeq ?? null, detectedAt: iso(), action: ACTION },
            attempts: [], nextAttemptAt: now()
        };
        // Reconstrucción tras perder el servidor de la aplicación: el testigo recuerda el ciclo abierto.
        if (!prior && witnessSeen && witnessSeen.state === 'open') { entry.witnessOpen = true; entry.delivered = witnessSeen.delivered; entry.witnessDelivered = witnessSeen.delivered; }
        outbox.put(entry);
        return entry;
    }

    // Despachador ÚNICO de incidentes: el conciliador y el reintento lo invocan, pero solo hay una pasada a la vez, de modo que un
    // incidente nunca tiene dos envíos simultáneos. Cada intento se anota con su resultado real, y solo se escribe a disco cuando
    // hay una transición (nuevo intento, entrega, evento de trazabilidad); los incidentes sin cambios no se reescriben.
    // El acuse del canal prueba recepción técnica, no atención humana: esa es evidencia propia (evento attended de Soporte).
    let dispatching = null;
    function deliverIncidents() {
        if (dispatching) return dispatching;
        dispatching = (async () => {
            const out = [];
            for (const entry of outbox.all()) {
                let changed = false;
                try {
                    if (!entry.witnessOpen) { const w = await witness.postIncident(witnessCfg, { ...entry.incident, type: 'open', cycle: entry.cycle }); if (w.status === 201) { entry.witnessOpen = true; changed = true; } }
                    if (entry.witnessOpen && entry.delivered && !entry.witnessDelivered) { const w = await witness.postIncident(witnessCfg, { id: entry.id, type: 'delivered', code: entry.incident.code, business: entry.incident.business, patient: entry.incident.patient, attempts: entry.attempts.length, cycle: entry.cycle }); if (w.status === 201) { entry.witnessDelivered = true; changed = true; } }
                    if (entry.witnessOpen && entry.cleared && !entry.witnessCleared) { const w = await witness.postIncident(witnessCfg, { id: entry.id, type: 'cleared', code: entry.incident.code, business: entry.incident.business, patient: entry.incident.patient, detectedAt: entry.clearedAt, cycle: entry.cycle }); if (w.status === 201) { entry.witnessCleared = true; changed = true; } }
                } catch { /* testigo inaccesible: el incidente sigue en la cola local */ }
                if (!entry.delivered && now() >= (entry.nextAttemptAt ?? 0)) {
                    const result = await alert({ ...entry.incident, cycle: entry.cycle }, entry.attempts.length + 1).catch(error => ({ ok: false, channel: 'unknown', error: String(error.message).slice(0, 30) }));
                    entry.attempts.push({ at: iso(), channel: result.channel, ok: Boolean(result.ok), ...(result.status ? { status: result.status } : {}), ...(result.error ? { error: result.error } : {}) });
                    if (result.ok) { entry.delivered = true; entry.deliveredAt = iso(); entry.nextAttemptAt = null; }
                    else entry.nextAttemptAt = now() + backoff(entry.attempts.length);
                    changed = true;
                    out.push({ id: entry.id, attempt: entry.attempts.length, ok: Boolean(result.ok), channel: result.channel });
                }
                if (changed) outbox.put(entry);
            }
            return out;
        })().finally(() => { dispatching = null; });
        return dispatching;
    }

    async function tick() {
        if (running) return last;
        running = true;
        const started = now(), result = { at: iso(), state: 'ok', incidents: [], delivered: null };
        try {
            result.delivered = await witness.deliver(db, witnessCfg).catch(() => null);
            let fetched;
            try {
                fetched = await witness.anchors(witnessCfg);
                if (fetched.status !== 200) throw new Error('HTTP_' + fetched.status);
            } catch {
                failures++;
                result.state = 'unreachable';
                if (failures >= unreachableAfter) ensure({ business: '*', patient: '*', code: 'REFERENCE_UNREACHABLE', severity: 'warning' });
                result.incidents = await deliverIncidents();
                return (last = result);
            }
            failures = 0;
            const known = await incidentState();
            const cfg = integrity.config();
            const heads = new Map((await db.query('SELECT * FROM evolution_integrity_head', { type: QueryTypes.SELECT })).map(h => [h.id_business + '|' + h.id_person, h]));
            const patients = new Map();
            const patientOf = rec => {
                const k = rec.business + '|' + rec.patient;
                if (!patients.has(k)) patients.set(k, { business: rec.business, patient: rec.patient, recs: [], conflicts: [] });
                return patients.get(k);
            };
            for (const { rec } of fetched.data.anchors) patientOf(rec).recs.push(rec);
            for (const { rec } of fetched.data.conflicts) patientOf(rec).conflicts.push(rec);
            const entryAt = async (p, seq) => (await db.query('SELECT * FROM evolution_integrity_ledger WHERE id_business=:b AND id_person=:p AND seq=:s',
                { replacements: { b: p.business, p: p.patient, s: seq }, type: QueryTypes.SELECT }))[0];
            const found = [];
            for (const p of patients.values()) {
                p.recs.sort((a, b) => a.seq - b.seq);
                const top = p.recs[p.recs.length - 1];
                if (top) {
                    const key = cfg.keys.get(top.keyId);
                    if (key && integrity.entryMac(key, { id_business: top.business, id_person: top.patient, seq: top.seq, note_id: top.note, version: top.version, format: top.format,
                        digest: top.digest, previous_digest: top.previousDigest, prev_mac: top.prevMac, sealed_at_text: top.sealedAt, key_id: top.keyId }) !== top.mac)
                        found.push({ business: p.business, patient: p.patient, code: 'WITNESS_RECORD_INVALID', severity: 'critical', note: top.note, witnessSeq: top.seq });
                }
                const head = heads.get(p.business + '|' + p.patient), headSeq = head ? Number(head.last_seq) : 0;
                const topSeq = top ? top.seq : 0;
                const base = { business: p.business, patient: p.patient, note: top && top.note, witnessSeq: topSeq, databaseSeq: headSeq };
                let adopted = false;
                for (const c of p.conflicts) { const at = await entryAt(p, c.seq); if (at && at.mac === c.mac) adopted = true; }
                if (adopted) found.push({ ...base, code: 'HISTORY_DIVERGED', severity: 'critical' });
                else if (headSeq < topSeq) {
                    const at = headSeq ? await entryAt(p, headSeq) : null;
                    const theirs = p.recs.find(r => r.seq === headSeq);
                    found.push({ ...base, code: at && theirs && at.mac !== theirs.mac ? 'HISTORY_DIVERGED' : 'ROLLBACK_SUSPECTED', severity: 'critical' });
                } else if (headSeq === topSeq) {
                    if (head.last_mac !== top.mac) found.push({ ...base, code: 'HISTORY_DIVERGED', severity: 'critical' });
                } else if (top) {
                    const at = await entryAt(p, topSeq);
                    if (!at || at.mac !== top.mac) found.push({ ...base, code: 'HISTORY_DIVERGED', severity: 'critical' });
                }
            }
            for (const [k, head] of heads) if (!patients.has(k)) patients.set(k, { business: head.id_business, patient: head.id_person, recs: [], conflicts: [], onlyDb: true });
            const confirmed = new Set(found.map(f => f.business + '|' + f.patient));
            for (const p of patients.values()) {
                const k = p.business + '|' + p.patient, head = heads.get(k);
                if (!head || confirmed.has(k)) continue;
                const topSeq = p.recs.length ? p.recs[p.recs.length - 1].seq : 0;
                if (Number(head.last_seq) <= topSeq) continue;
                const rows = await db.query('SELECT *, DATE_FORMAT(sealed_at,\'' + integrity.TEXT_TIME + '\') AS sealed_at_text FROM evolution_integrity_ledger WHERE id_business=:b AND id_person=:p AND seq>:s ORDER BY seq',
                    { replacements: { b: p.business, p: p.patient, s: topSeq }, type: QueryTypes.SELECT });
                // El testigo va atrasado: se extiende solo con asientos autenticados que continúan su último registro.
                let tail = p.recs.length ? p.recs[p.recs.length - 1].mac : integrity.GENESIS, extended = true;
                for (const row of rows) {
                    const key = cfg.keys.get(row.key_id);
                    if (!key || row.prev_mac !== tail || integrity.entryMac(key, row) !== row.mac) { extended = false; break; }
                    tail = row.mac;
                }
                const oldest = rows.length ? Date.parse(rows[0].sealed_at_text.replace(' ', 'T') + 'Z') : now();
                if (extended) {
                    for (const row of rows) await witness.enqueue(db, undefined, { business: row.id_business, patient: row.id_person, note: row.note_id, version: row.version, seq: row.seq });
                    await witness.deliver(db, witnessCfg, { business: p.business, patient: p.patient, force: true }).catch(() => null);
                }
                if (!extended || now() - oldest > staleMs)
                    found.push({ business: p.business, patient: p.patient, code: extended ? 'REFERENCE_STALE' : 'REFERENCE_UNVERIFIABLE', severity: 'warning', witnessSeq: topSeq, databaseSeq: Number(head.last_seq) });
            }
            active.clear();
            for (const f of found) ensure(f, known);
            // Condición resuelta: se anota (local y en el testigo); el cierre exige una acción explícita de Soporte.
            for (const entry of outbox.all()) {
                if (entry.cleared) continue;
                const still = [...active.values()].some(list => list.some(c => c.id === entry.id));
                if (!still) { entry.cleared = true; entry.clearedAt = iso(); outbox.put(entry); }
            }
            result.incidents = await deliverIncidents();
            return (last = result);
        } catch (error) {
            result.state = 'error'; result.error = error.message;
            console.error('NC3_RECONCILER_ERROR', error.message);
            return (last = result);
        } finally { running = false; result.tookMs = now() - started; }
    }

    // Reintentos: cola de referencias al testigo y cola de incidentes, cada una con su espera progresiva.
    async function retry() {
        if (retrying) return null;
        retrying = true;
        try { return { references: await witness.deliver(db, witnessCfg).catch(() => null), incidents: await deliverIncidents() }; } finally { retrying = false; }
    }

    return {
        tick, retry, deliverIncidents,
        start(intervalMs = 300000, { immediate = true, retryMs = 5000 } = {}) {
            if (timer) return true;
            if (!outbox.acquire()) { console.error('NC3_DISPATCHER_ALREADY_RUNNING'); return false; }
            timer = setInterval(() => { tick(); }, Math.max(500, Number(intervalMs))); timer.unref();
            retryTimer = setInterval(() => { retry(); }, Math.max(200, Number(retryMs))); retryTimer.unref();
            if (immediate) tick();
            return true;
        },
        stop() { if (timer) clearInterval(timer); if (retryTimer) clearInterval(retryTimer); timer = retryTimer = null; outbox.release(); },
        // Condiciones vigentes para un paciente: solo de su consultorio (el aviso de lectura no cruza consultorios).
        faultsFor(business, patient) { return (active.get(business + '|' + patient) || []).filter(c => c.severity === 'critical').map(c => ({ code: c.code, state: 'discrepancy' })); },
        // Advertencias visibles para el profesional que NO bloquean nada ni se presentan como discrepancia.
        warningsFor(business, patient) { return (active.get(business + '|' + patient) || []).filter(c => c.code === 'REFERENCE_UNVERIFIABLE').map(c => ({ code: c.code })); },
        outbox: () => outbox.all(),
        last: () => last
    };
}

let shared = null;
module.exports = { createReconciler, ACTION, shared: () => shared, install(reconciler) { shared = reconciler; return reconciler; } };

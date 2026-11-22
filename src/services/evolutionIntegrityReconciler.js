'use strict';
// NC3/C22: conciliador. Compara las cabeceras de integridad de MySQL con la referencia externa (testigo) y avisa a
// Soporte aunque nadie abra el expediente. Distingue cuatro situaciones:
//   - ROLLBACK_SUSPECTED / HISTORY_DIVERGED / WITNESS_RECORD_INVALID: discrepancia confirmada (el testigo es autoritativo).
//   - REFERENCE_STALE: el testigo va atrasado respecto de MySQL (mantenimiento, no discrepancia).
//   - REFERENCE_UNREACHABLE: no se pudo consultar el testigo (nunca se declara discrepancia por eso).
// El testigo nunca se sobrescribe con el estado de MySQL: solo se extiende si MySQL continúa exactamente su último registro.
const { createHash } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const integrity = require('./evolutionIntegrity.service');
const witness = require('./evolutionIntegrityWitness.service');

const ACTION = 'Soporte de HEMIA: confirmar con el responsable del consultorio, conservar evidencia y coordinar la recuperación en un entorno aislado.';

async function webhook(incident) {
    const url = process.env.EVOLUTION_INTEGRITY_ALERT_WEBHOOK_URL;
    if (!url) return true;
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(incident), signal: AbortSignal.timeout(3000) });
        return r.ok;
    } catch { return false; }
}
// Señal para Soporte: línea estructurada (sin texto clínico) y, si está configurado, webhook. Devuelve si se entregó.
async function defaultAlert(incident) {
    console.error('NC3_INTEGRITY_INCIDENT ' + JSON.stringify(incident));
    return webhook(incident);
}

function createReconciler({ db, witnessCfg = witness.config(), alert = defaultAlert, now = () => Date.now(), staleMs = 15 * 60000, unreachableAfter = 3 }) {
    const active = new Map();      // business|patient -> [{code,id}] condiciones vigentes (alimenta el aviso de lectura)
    const undelivered = new Map(); // id -> incidente cuyo aviso aún no se entregó
    let failures = 0, running = false, timer = null, last = null;
    const idOf = (business, patient, code) => 'INC-' + createHash('sha256').update([witnessCfg.envId, business, patient, code].join('|')).digest('hex').slice(0, 12);

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

    async function raise(found, known, result) {
        const id = idOf(found.business, found.patient, found.code);
        (active.get(found.business + '|' + found.patient) || active.set(found.business + '|' + found.patient, []).get(found.business + '|' + found.patient)).push({ code: found.code, id });
        const prior = known.get(id);
        if (prior && prior.state === 'open' && prior.delivered) return;
        const incident = { id, env: witnessCfg.envId, code: found.code, severity: found.severity, business: found.business, patient: found.patient,
            note: found.note || null, witnessSeq: found.witnessSeq ?? null, databaseSeq: found.databaseSeq ?? null, detectedAt: new Date(now()).toISOString(), action: ACTION };
        if (!prior || prior.state !== 'open') {
            const written = await witness.postIncident(witnessCfg, { ...incident, type: 'open' });
            if (written.status !== 201) throw new Error('INCIDENT_WRITE_FAILED');
        }
        // El aviso se considera entregado solo cuando el canal lo acepta; se anota en el testigo para sobrevivir a reinicios.
        if (await alert(incident)) await witness.postIncident(witnessCfg, { id, type: 'delivered', code: incident.code, business: incident.business, patient: incident.patient, detectedAt: new Date(now()).toISOString() });
        result.incidents.push(incident);
    }

    async function tick() {
        if (running) return last;
        running = true;
        const started = now(), result = { at: new Date(started).toISOString(), state: 'ok', incidents: [], flushed: null };
        try {
            result.flushed = await witness.flush(witnessCfg);
            let fetched;
            try {
                fetched = await witness.anchors(witnessCfg);
                if (fetched.status !== 200) throw new Error('HTTP_' + fetched.status);
            } catch (error) {
                failures++;
                result.state = 'unreachable';
                if (failures === unreachableAfter) {
                    const inc = { id: idOf('*', '*', 'REFERENCE_UNREACHABLE'), env: witnessCfg.envId, code: 'REFERENCE_UNREACHABLE', severity: 'warning', detectedAt: new Date(now()).toISOString(), action: ACTION };
                    await alert(inc);
                    result.incidents.push(inc);
                }
                return (last = result);
            }
            failures = 0;
            const known = await incidentState();
            const cfg = integrity.config();
            const heads = new Map((await db.query('SELECT * FROM evolution_integrity_head', { type: QueryTypes.SELECT })).map(h => [h.id_business + '|' + h.id_person, h]));
            const patients = new Map();
            for (const { rec } of fetched.data.anchors) {
                const k = rec.business + '|' + rec.patient;
                if (!patients.has(k)) patients.set(k, { business: rec.business, patient: rec.patient, recs: [], conflicts: [] });
                patients.get(k).recs.push(rec);
            }
            for (const { rec } of fetched.data.conflicts) {
                const k = rec.business + '|' + rec.patient;
                if (!patients.has(k)) patients.set(k, { business: rec.business, patient: rec.patient, recs: [], conflicts: [] });
                patients.get(k).conflicts.push(rec);
            }
            const entryAt = async (p, seq) => (await db.query('SELECT * FROM evolution_integrity_ledger WHERE id_business=:b AND id_person=:p AND seq=:s',
                { replacements: { b: p.business, p: p.patient, s: seq }, type: QueryTypes.SELECT }))[0];
            const next = new Map();
            const found = [];
            for (const p of patients.values()) {
                p.recs.sort((a, b) => a.seq - b.seq);
                const top = p.recs[p.recs.length - 1];
                if (top) {
                    const key = cfg.keys.get(top.keyId);
                    if (key && integrity.entryMac(key, { id_business: top.business, id_person: top.patient, seq: top.seq, note_id: top.note, version: top.version, format: top.format,
                        digest: top.digest, previous_digest: top.previousDigest, prev_mac: top.prevMac, sealed_at_text: top.sealedAt, key_id: top.keyId }) !== top.mac)
                        found.push({ ...p, code: 'WITNESS_RECORD_INVALID', severity: 'critical', note: top.note, witnessSeq: top.seq });
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
                    for (const row of rows) {
                        const key = cfg.keys.get(row.key_id);
                        await witness.publish(witnessCfg, { entry: row, head: { mac: integrity.headMac(key, { id_business: row.id_business, id_person: row.id_person, last_seq: row.seq, last_mac: row.mac, key_id: row.key_id }) } });
                    }
                }
                if (!extended || now() - oldest > staleMs)
                    found.push({ business: p.business, patient: p.patient, code: extended ? 'REFERENCE_STALE' : 'REFERENCE_UNVERIFIABLE', severity: 'warning', witnessSeq: topSeq, databaseSeq: Number(head.last_seq) });
            }
            active.clear();
            for (const f of found) await raise(f, known, result);
            // Condición resuelta: se anota en el testigo, pero el cierre exige una acción explícita de Soporte.
            for (const [id, state] of known) {
                if (state.state !== 'open') continue;
                const still = [...active.values()].some(list => list.some(c => c.id === id));
                if (!still && id.startsWith('INC-')) {
                    const event = (await witness.incidents(witnessCfg)).data.events.filter(e => e.id === id && e.type === 'open').pop();
                    if (event) await witness.postIncident(witnessCfg, { id, type: 'cleared', code: event.code, business: event.business, patient: event.patient, detectedAt: new Date(now()).toISOString() });
                }
            }
            return (last = result);
        } catch (error) {
            result.state = 'error'; result.error = error.message;
            console.error('NC3_RECONCILER_ERROR', error.message);
            return (last = result);
        } finally { running = false; result.tookMs = now() - started; }
    }

    return {
        tick,
        start(intervalMs = 300000, { immediate = true } = {}) {
            if (timer) return;
            const every = Math.max(1000, Number(intervalMs));
            timer = setInterval(() => { tick(); }, every);
            timer.unref();
            if (immediate) tick();
        },
        stop() { if (timer) clearInterval(timer); timer = null; },
        // Condiciones vigentes para un paciente: solo de su consultorio (el aviso de lectura no cruza consultorios).
        faultsFor(business, patient) { return (active.get(business + '|' + patient) || []).filter(c => c.code !== 'REFERENCE_STALE').map(c => ({ code: c.code, state: 'discrepancy' })); },
        last: () => last
    };
}

let shared = null;
module.exports = { createReconciler, ACTION, shared: () => shared, install(reconciler) { shared = reconciler; return reconciler; } };

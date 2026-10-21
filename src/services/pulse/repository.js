'use strict';
const { consistentRead } = require('./readConnection');
const { aggregate, page, signaturePopulation } = require('../../domain/pulse/queries');
const { CORE, SOURCES } = require('../../domain/pulse/rules');
const time = require('../../domain/pulse/time');
const preparationSql = `SELECT 'agenda-hours' AS id,COUNT(*) AS requiredCount,
 COALESCE(SUM(NOT EXISTS(SELECT 1 FROM appointment_working_day wd JOIN appointment_time_range tr ON tr.id_appointment_working_day=wd.id_appointment_working_day AND tr.id_business=wd.id_business
 WHERE wd.id_appointment_config=ac.id_appointment_config AND wd.id_business=ac.id_business AND wd.enabled=1 AND tr.start_time>='00:00:00' AND tr.end_time<'24:00:00' AND tr.start_time<tr.end_time)),0) AS blockedCount
 FROM appointment_config ac JOIN doctor_professional_profile d ON d.id_doctor_professional_profile=ac.doctor_profile_id AND d.id_business=ac.id_business AND d.is_active=1
 JOIN login l ON l.id_login=d.id_login AND l.id_business=d.id_business AND l.active=1
 WHERE ac.id_business=:business AND ac.active=1 AND ac.enabled=1
 AND NOT EXISTS(SELECT 1 FROM appointment_config general WHERE general.id_business=ac.id_business AND general.doctor_profile_id IS NULL AND general.active=1 AND general.enabled=0)
 UNION ALL
 SELECT 'prescription-readiness',COUNT(*),COALESCE(SUM(NULLIF(TRIM(pc.clinic_address),'') IS NULL OR NULLIF(TRIM(pc.clinic_phone),'') IS NULL OR NULLIF(TRIM(d.professional_name),'') IS NULL OR NULLIF(TRIM(d.professional_license),'') IS NULL OR NULLIF(TRIM(d.signature_image),'') IS NULL),0)
 FROM prescription_config pc JOIN doctor_professional_profile d ON d.id_doctor_professional_profile=pc.doctor_profile_id AND d.id_business=pc.id_business COLLATE utf8mb4_unicode_ci AND d.is_active=1 AND d.can_issue_prescriptions=1
 JOIN login l ON l.id_login=d.id_login AND l.id_business=d.id_business AND l.active=1
 WHERE pc.id_business=:business AND pc.active=1`;
const signingPreparationSql = `${signaturePopulation(true)} SELECT 'document-signing-readiness' AS id,COUNT(*) AS requiredCount,COALESCE(SUM(d.id_doctor_professional_profile IS NULL OR l.id_login IS NULL OR d.can_sign_documents<>1 OR NULLIF(TRIM(d.signature_image),'') IS NULL OR NULLIF(TRIM(d.professional_name),'') IS NULL OR NULLIF(TRIM(d.professional_license),'') IS NULL),0) AS blockedCount
 FROM patient_documents pd LEFT JOIN doctor_professional_profile d ON d.id_doctor_professional_profile=pd.responsible_doctor_profile_id AND d.id_business=pd.id_business AND d.is_active=1
 LEFT JOIN login l ON l.id_login=d.id_login AND l.id_business=d.id_business AND l.active=1
 WHERE pd.id_business=:business AND pd.active=1 AND pd.status IN('BORRADOR','PENDIENTE_FIRMA') AND NULLIF(pd.doctor_signature_snapshot,'') IS NULL
 AND EXISTS(SELECT 1 FROM obligations r WHERE r.id_patient_document=pd.id_patient_document AND r.signature_role='DOCTOR' AND r.eligible=1)`;
function preparation(rows, asOf, zone) {
    const tasks = { 'agenda-hours': 'reservar_horario', 'prescription-readiness': 'emitir_receta', 'document-signing-readiness': 'firmar_documento' };
    const items = rows.filter(r => Number(r.requiredCount) > 0).map(r => ({ id: r.id, class: 'necessary', ready: Number(r.blockedCount) === 0, tasks: [tasks[r.id]], cause: Number(r.blockedCount) ? 'Requisitos incompletos para la funcion habilitada o tarea vigente.' : null, help: 'La preparacion no concede permisos; revisa el modulo autorizado.', action: null }));
    if (items.some(i => i.id === 'agenda-hours') && zone.source === 'fallback') items.push({ id: 'clinic-timezone', class: 'necessary', ready: false, tasks: ['reservar_horario'], cause: 'Falta confirmar una zona IANA general valida.', help: 'La zona fallback no acredita configuracion.', action: null });
    if (!items.length) items.push({ id: 'functions-not-confirmed', class: 'needs_confirmation', ready: null, tasks: [], cause: null, help: 'Sin evidencia de una tarea vigente o funcion habilitada que requiera configuracion.', action: null });
    return { state: items.some(i => i.ready === false) ? 'blocked' : items.some(i => i.class === 'necessary') ? 'ready' : 'needs_confirmation', items, quality: { classification: 'complete', readAt: new Date(asOf).toISOString(), explanation: 'Agenda habilitada, formato propio activo con emision habilitada y solicitudes DOCTOR vigentes. Otras funciones sin evidencia: necesidad por confirmar; logo opcional.' } };
}
class PulseRepository {
    constructor(db, { onMetric = () => {} } = {}) { this.db = db; this.onMetric = onMetric; }
    async appointmentResult(business, recordId) {
        return consistentRead(this.db, async query => {
            const rows = await query(`SELECT a.status FROM appointment a
             JOIN person p ON p.id_person=a.id_person AND p.id_business=a.id_business AND p.active=1
             WHERE a.id_business=:business AND a.id_appointment=:recordId AND a.active=1 LIMIT 1`, { business, recordId });
            return rows[0]?.status || null;
        });
    }
    async read(business, asOf) {
        const metrics = {};
        const result = await consistentRead(this.db, async query => {
            const configs = await query('SELECT timezone FROM appointment_config WHERE id_business=:business AND active=1 AND doctor_profile_id IS NULL ORDER BY created_at DESC,id_appointment_config LIMIT 1', { business });
            const zone = time.timeZone(configs[0]?.timezone), today = time.date(asOf, zone.name), midnight = time.nextMidnight(asOf, zone.name);
            const values = { business, today, zone: zone.name, asOf: time.sqlTime(asOf), midnight: time.sqlTime(midnight || asOf + time.DAY) };
            const input = {}, failures = {};
            // Statement-level source failures do not fabricate zero. Fatal/timeout invalidates the whole read.
            metrics.sources = {};
            const block = async (id, fn) => { const start = Date.now(); let outcome = 'ok'; try { return await fn(); } catch (e) { outcome = 'failed'; if (!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) { e.pulseSource = id; throw e; } outcome = 'unavailable'; failures[id] = e.code; return null; } finally { metrics.sources[id] = Date.now() - start; this.onMetric('source', { source: id, outcome, elapsedMs: metrics.sources[id] }); } };
            for (let i = 0; i < CORE.length; i++) input[SOURCES[i]] = await block(SOURCES[i], async () => (await query(aggregate(CORE[i]), values))[0]);
            const prepared = await block('preparation', () => query(preparationSql, values));
            const signing = await block('preparationSigning', () => query(signingPreparationSql, values));
            input.preparation = prepared || signing ? preparation([...(prepared || []), ...(signing || [])], asOf, zone) : null;
            if (input.preparation && (!prepared || !signing)) { input.preparation.quality.classification = 'partial'; input.preparation.quality.explanation = 'Hay requisitos conocidos; no se pudo verificar toda la preparacion.'; if (!input.preparation.items.some(i => i.class === 'necessary')) input.preparation.state = 'unknown'; }
            const startToday = time.wall(today, '00:00:00', zone.name), startDay = new Date(Date.parse(today + 'T00:00:00Z') - 7 * time.DAY).toISOString().slice(0, 10), start = time.wall(startDay, '00:00:00', zone.name);
            input.activity = await block('activity', async () => {
                const [counts] = await query(`SELECT
                 (SELECT COUNT(*) FROM appointment a JOIN person p ON p.id_person=a.id_person AND p.id_business=a.id_business AND p.active=1 WHERE a.id_business=:business AND a.active=1 AND a.created_at>=:start AND a.created_at<:end) AS appointmentsCreated,
                 (SELECT COUNT(*) FROM prescription pr JOIN person p ON p.id_person=pr.id_person COLLATE utf8mb4_unicode_ci AND p.id_business=pr.id_business COLLATE utf8mb4_unicode_ci AND p.active=1 WHERE pr.id_business=:business AND pr.active=1 AND pr.status='issued' AND COALESCE(pr.issued_at,pr.created_at)>=:start AND COALESCE(pr.issued_at,pr.created_at)<:end) AS prescriptionsIssued,
                 (SELECT COUNT(*) FROM clinical_histories ch JOIN person p ON p.id_person=ch.patient_id AND p.id_business=ch.business_id AND p.active=1 WHERE ch.business_id=:business AND ch.status='FINALIZED' AND ch.deleted_at IS NULL AND ch.finalized_at>=:start AND ch.finalized_at<:end) AS clinicalHistoriesFinalized`, { business, start: time.sqlTime(start), end: time.sqlTime(startToday) });
                return { available: true, counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])), window: { from: new Date(start).toISOString(), to: new Date(startToday).toISOString() } };
            });
            return { input, zone, failures };
        }, { metrics });
        return { ...result, metrics };
    }
    async incidents(business, indicator, asOf, cursor, limit) {
        return consistentRead(this.db, async query => {
            const configs = await query('SELECT timezone FROM appointment_config WHERE id_business=:business AND active=1 AND doctor_profile_id IS NULL ORDER BY created_at DESC,id_appointment_config LIMIT 1', { business });
            const zone = time.timeZone(configs[0]?.timezone);
            const values = { business, asOf: time.sqlTime(asOf), zone: zone.name, today: time.date(asOf, zone.name), limit: limit + 1, ...(cursor ? { priority: cursor.priority, due: cursor.dueAt, lastId: cursor.recordId } : {}) };
            const [totals] = await query(aggregate(indicator), { ...values, midnight: time.sqlTime(time.nextMidnight(asOf, zone.name)) });
            const rows = await query(page(indicator, Boolean(cursor)), values);
            return { rows, totalKnown: Number(totals.invalidRecords) ? null : Number(totals.numerator), zone: zone.name };
        });
    }
}
module.exports = { PulseRepository, preparation, preparationSql };

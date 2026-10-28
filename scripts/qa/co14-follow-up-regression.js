const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const inject = (file, value) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports: value }; };
const body = { id_business: 'clinic', id_login: 'doctor', id_person: 'patient' };
let receipts = [], audits = [];
let traces = [], versions = [], appointments = [], allowed = true, queries = [], appointmentWrites = 0;
let treatment = { id_patient_treatment: 'procedure', id_treatment_plan: 'plan', name: 'Procedimiento original', business: 'clinic', patient: 'patient', active: true, planActive: true, status: 'pending' };
const clone = value => JSON.parse(JSON.stringify(value));
const scoped = (row, r) => row.id_business === r.business && row.id_person === r.patient;
const config = { enabled: true, defaultAppointmentDuration: 30, timezone: 'America/Mexico_City', blockedDates: [], blockedHours: [],
    workingDays: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, enabled: true, timeRanges: [{ startTime: '09:00', endTime: '17:00' }] })) };
const db = {
    async transaction() {
        const before = clone({ traces, versions, appointments, receipts, audits });
        return { finished: false, async commit() { this.finished = true; }, async rollback() {
            receipts = before.receipts; audits = before.audits; traces = before.traces; versions = before.versions; appointments = before.appointments; this.finished = true;
        } };
    },
    async query(sql, options = {}) {
        queries.push(sql);
        const r = options.replacements || {};
        if (/SELECT revision FROM appointment_config/.test(sql)) return [{revision:1}];
        if (/SELECT l.id_login FROM login l/.test(sql)) return r.business === body.id_business && r.actor === body.id_login ? [{ id_login: body.id_login }] : [];
        if (/FROM person/.test(sql) && !/FROM appointment/.test(sql)) {
            const business = r.business || r._id_business, patient = r.patient || r._id_person;
            return business === body.id_business && patient === body.id_person ? [{ id_person: body.id_person, active: 1 }] : [];
        }
        if (/FROM patient_treatment pt/.test(sql)) {
            assert.match(sql, /tp\.status = 'active'/); assert.match(sql, /pt\.status <> 'cancelled'/);
            assert.match(sql, /pt\.id_business/); assert.match(sql, /pt\.id_person/); assert.match(sql, /FOR UPDATE/);
            return r.treatment === treatment.id_patient_treatment && r.business === treatment.business && r.patient === treatment.patient
                && treatment.active && treatment.planActive && treatment.status !== 'cancelled' ? [clone(treatment)] : [];
        }
        if (/SELECT t\.\* FROM tracing/.test(sql)) return traces.filter(t => t.id_tracing === r.id && scoped(t, r)).map(clone);
        if (/INSERT INTO tracing \(/.test(sql)) {
            if (traces.some(t => t.id_tracing === r.id)) throw new Error('Duplicate primary key');
            traces.push({ ...clone(r), id_tracing: r.id, id_business: r.business, id_person: r.patient,
                created_by: r.actor, revision: 1, status: 'active' }); return [];
        }
        if (/UPDATE tracing SET quote_date/.test(sql)) {
            const current = traces.find(t => t.id_tracing === r.id && scoped(t, r));
            Object.assign(current, clone(r), { revision: current.revision + 1 }); return [];
        }
        if (/SELECT id_tracing_revision FROM tracing_revision/.test(sql)) return versions.filter(v => v.tracing === r.id && v.business === r.business && v.revision === r.revision);
        if (/INSERT INTO tracing_revision/.test(sql)) { versions.push(clone(r)); return []; }
        if (/SELECT 1 FROM tracing/.test(sql)) return traces.some(t => t.id_tracing === r.id && scoped(t, r)) ? [{ value: 1 }] : [];
        if (/SELECT status FROM tracing/.test(sql)) return traces.filter(t => t.id_tracing === r.id && scoped(t, r)).map(t => ({ status: t.status }));
        if (/SELECT id_business FROM business/.test(sql)) { assert.match(sql, /FOR UPDATE/); return [{ id_business: body.id_business }]; }
        if (/SELECT id_appointment FROM appointment/.test(sql)) return appointments.filter(a => a.id === r.id && a.business === r.business).map(a => ({ id_appointment: a.id }));
        if (/FROM appointment_write_request/.test(sql)) return receipts.filter(x=>x.business===r.business && x.requestId===r.requestId).map(x=>({actor_id:x.actor,operation:x.operation,payload_hash:x.hash,appointment_id:x.id}));
        if (/INSERT INTO appointment_write_request/.test(sql)) { receipts.push(clone(r));return []; }
        if (/INSERT INTO appointment_audit/.test(sql)) { audits.push(clone(r));return []; }
        if (/UPDATE appointment SET status='rescheduled'/.test(sql)) {
            const item = appointments.find(a => a.id === r.id && a.business === r.business);
            item.status = 'rescheduled'; item.blocks = 0; return [];
        }
        if (/^(INSERT INTO appointment\(|UPDATE appointment SET)/.test(sql)) {
            appointmentWrites++;const index=appointments.findIndex(a=>a.id===r.id && a.business===r.business);
            const item={...clone(r),revision:index<0?1:appointments[index].revision+1};
            if(index<0)appointments.push(item);else appointments[index]=item;return [];
        }
        if (/FROM appointment a/.test(sql)) {
            if (/a.id_appointment=:id/.test(sql)) return appointments.filter(a=>a.id===r.id && a.business===r.business).map(clone);
            if (/SELECT 1/.test(sql)) {
                return appointments.some(a => a.business === r._id_business && a.doctorProfileId === r._doctor_profile_id && a.date === r._appointment_date
                    && a.id !== r._id_appointment && ['pending_confirmation', 'confirmed', 'completed'].includes(a.status)
                    && a.startTime < r._end_time && a.endTime > r._start_time) ? [{ value: 1 }] : [];
            }
            if (/FOR UPDATE/.test(sql)) return appointments.filter(a => a.business === r.business && a.patientId === r.patient && a.followUpId === r.tracing).map(clone);
            let rows = appointments.filter(a => a.business === r._id_business && a.patientId === r._id_person);
            if (r._id_tracing) { assert.match(sql, /a\.id_tracing.*:_id_tracing/); rows = rows.filter(a => a.followUpId === r._id_tracing); }
            if (sql.includes("a.status IN ('pending_confirmation', 'confirmed')")) rows = rows.filter(a => ['pending_confirmation', 'confirmed'].includes(a.status));
            if (r._upcoming_from) { assert.match(sql, /a.status IN \('pending_confirmation', 'confirmed'\)/); rows = rows.filter(a => ['pending_confirmation', 'confirmed'].includes(a.status) && a.date >= r._upcoming_from); }
            if (r._upcoming_time) { assert.match(sql, /a.start_time > TIME\(:_upcoming_time\)/); rows = rows.filter(a => a.date > r._upcoming_from || a.startTime > r._upcoming_time); }
            rows.sort((a, b) => (r._upcoming_from ? 1 : -1) * `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
            const limit = Number(/LIMIT (\d+)/.exec(sql)[1]), offset = Number(/OFFSET (\d+)/.exec(sql)[1]);
            return rows.slice(offset, offset + limit).map(clone);
        }
        if (/SP_appointment_config_get/i.test(sql)) return clone(config);
        if (/SP_appointment_save/i.test(sql)) {
            appointmentWrites++;
            const input = JSON.parse(r._appointment), item = { ...input, id: input.id || uuid(), business: r._id_business };
            const index = appointments.findIndex(a => a.id === item.id);
            if (index >= 0) appointments[index] = item; else appointments.push(item);
            return [clone(item)];
        }
        throw new Error(`Unhandled QA SQL: ${sql}`);
    }
};
inject('../../src/db/Sequelize.connection', db);
inject('../../src/util/effectivePermissions', { hasPermission: async () => allowed });
inject('../../src/util/professionalContext', { listProfessionals: async () => [], resolveProfessional: async (_body, id) => ['doctor-profile', 'doctor-profile-2'].includes(id)
    ? { doctor: { id_doctor_professional_profile: id, professional_name: 'QA Doctor' } } : { error: { status: 400 } } });
inject('../../src/Dao/mysql/user.dao', {});
const tracing = require('../../src/Dao/mysql/tracing.Dao');
const agenda = require('../../src/Dao/mysql/appointment.Dao');
const validation = require('../../src/domain/tracing/tracingValidation');

(async () => {
    const free = { id_tracing: uuid(), quote_date_now: '14-10-2026', treatment_now: 'Revision de rutina', quote_date_after: '', treatment_after: '', note: 'Consulta sin cita' };
    assert.throws(() => validation.rows({ tracing: [{ ...free, treatment_now: '' }] }));
    assert.throws(() => validation.rows({ tracing: [{ ...free, id_tracing: 'not-a-uuid' }] }));
    assert.throws(() => validation.rows({ tracing: [free, free] }));
    let result = await tracing.saveTracing({ ...body, tracing: [free] });
    assert.equal(result.status, 200, result.message); assert.equal(result.data[0].id_patient_treatment, null);
    assert.equal(result.data[0].quote_date_after, null); assert.equal(result.data[0].treatment_now, free.treatment_now);
    assert.equal((await tracing.saveTracing({ ...body, tracing: [free] })).status, 200);
    assert.equal(traces.length, 1); assert.equal(versions.length, 1, 'Same UUID retry creates neither another row nor another revision');
    result = await tracing.saveTracing({ ...body, tracing: [{ ...free, note: 'Changed after lost response' }] });
    assert.equal(result.status, 409); assert.equal(result.data.code, 'TRACING_CREATE_CONFLICT'); assert.equal(traces.length, 1);

    const linked = { ...free, id_tracing: uuid(), id_patient_treatment: 'procedure', treatment_now: 'Tampered label', treatment_after: 'Control', quote_date_after: '20-10-2026' };
    result = await tracing.saveTracing({ ...body, tracing: [linked] }); assert.equal(result.status, 200, result.message);
    const saved = result.data[0]; assert.equal(saved.id_treatment_plan, 'plan'); assert.equal(saved.id_patient_treatment, 'procedure');
    assert.equal(saved.treatment_now, 'Procedimiento original'); assert.equal(saved.treatment_text, 'Procedimiento original'); assert.equal(saved.treatment_relation_type, 'performed');
    assert.equal(treatment.status, 'pending', 'Tracing does not infer treatment status');
    treatment.name = 'Renamed later'; treatment.planActive = false;
    assert.equal((await tracing.saveTracing({ ...body, tracing: [linked] })).status, 200, 'Lost response replay survives later plan closure/rename');
    assert.equal(traces.length, 2); assert.equal(versions.length, 2);
    const correction = { ...linked, treatment_now: saved.treatment_now, revision: 1, change_reason: 'Aclaracion', note: 'Updated note' };
    result = await tracing.UpdateTracing({ ...body, tracing: [correction] }); assert.equal(result.status, 200, result.message);
    assert.equal(result.data[0].treatment_now, 'Procedimiento original'); assert.equal(result.data[0].id_patient_treatment, 'procedure');
    assert.equal((await tracing.UpdateTracing({ ...body, tracing: [correction] })).status, 409, 'Existing revision guard remains');
    result = await tracing.UpdateTracing({ ...body, tracing: [{ ...correction, revision: 2, treatment_now: 'Change linked name' }] });
    assert.equal(result.status, 400, 'Linked procedure name correction must be explicit, never silently ignored');
    result = await tracing.UpdateTracing({ ...body, tracing: [{ ...correction, revision: 2, id_patient_treatment: null, treatment_now: 'Procedimiento corregido libre' }] });
    assert.equal(result.status, 200); assert.equal(result.data[0].id_patient_treatment, null); assert.equal(result.data[0].treatment_text, null);
    assert.equal(JSON.parse(versions.find(v => v.tracing === saved.id_tracing && v.revision === 1).snapshot).treatment_now, 'Procedimiento original');
    const unavailable = { ...linked, id_tracing: uuid() };
    assert.equal((await tracing.saveTracing({ ...body, tracing: [unavailable] })).status, 400, 'New links require an active plan');
    treatment.planActive = true; treatment.business = 'foreign';
    assert.equal((await tracing.saveTracing({ ...body, tracing: [unavailable] })).status, 400);
    treatment.business = body.id_business; treatment.patient = 'other-patient';
    assert.equal((await tracing.saveTracing({ ...body, tracing: [unavailable] })).status, 400);
    treatment.patient = body.id_person; treatment.status = 'cancelled';
    assert.equal((await tracing.saveTracing({ ...body, tracing: [unavailable] })).status, 400);
    allowed = false; const before = queries.length;
    assert.equal((await tracing.saveTracing({ ...body, tracing: [free] })).status, 403);
    assert.ok(!queries.slice(before).some(sql => /(?:FROM|INTO) tracing\b/.test(sql)), 'Permission denial precedes clinical reads/writes'); allowed = true;

    const appointment = { patientId: body.id_person, followUpId: free.id_tracing, doctorProfileId: 'doctor-profile', patientName: 'QA Patient',
        date: '2026-10-20', startTime: '09:00', endTime: '09:30', status: 'pending_confirmation', title: 'Revision de rutina', description: 'Proxima atencion', source: 'follow_up' };
    const request = { ...body, appointment, sync_follow_up: true, get request_id() { return uuid(); } };
    result = await agenda.save(request); assert.equal(result.status, 200, result.message); const appointmentId = result.data[0].id;
    assert.equal((await agenda.save(request)).status, 200); assert.equal(appointmentWrites, 1, 'Lost appointment response retry is idempotent');
    result = await agenda.save({ ...request, appointment: { ...appointment, startTime: '10:00', endTime: '10:30' } });
    assert.equal(result.status, 409); assert.equal(result.data.code, 'FOLLOW_UP_APPOINTMENT_ALREADY_EXISTS');
    assert.equal(result.data.appointment.id, appointmentId); assert.equal(appointmentWrites, 1, 'A changed retry slot never gets false success');
    assert.equal((await agenda.save({ ...request, appointment: { ...appointment, doctorProfileId: 'doctor-profile-2' } })).status, 409);
    result = await agenda.save({ ...request, appointment: { ...appointment, id: appointmentId, revision: appointments.find(a=>a.id===appointmentId).revision, title: 'Correccion explicita' } });
    assert.equal(result.status, 200); assert.equal(appointmentWrites, 2);
    appointments.find(a => a.id === appointmentId).status = 'confirmed';
    result = await agenda.save({ ...request, appointment: { ...appointment, id: appointmentId, revision: appointments.find(a=>a.id===appointmentId).revision, title: 'Correccion despues de confirmar' } });
    assert.equal(result.status, 200); assert.equal(result.data[0].status, 'confirmed', 'A stale pending payload cannot undo confirmation');
    for (const terminal of ['completed', 'cancelled', 'rescheduled', 'no_show']) {
        appointments.find(a => a.id === appointmentId).status = terminal;
        result = await agenda.save({ ...request, appointment: { ...appointment, id: appointmentId, revision: appointments.find(a=>a.id===appointmentId).revision } });
        assert.equal(result.status, 409); assert.equal(result.data.code, terminal === 'rescheduled' ? 'APPOINTMENT_REPLACED' : 'FOLLOW_UP_APPOINTMENT_TERMINAL');
        assert.equal((await agenda.save(request)).status, 409, `${terminal} does not create an implicit replacement`);
        assert.equal(appointments.find(a => a.id === appointmentId).status, terminal);
    }
    result = await agenda.save({ ...request, explicit_new_follow_up: true });
    assert.equal(result.status, 200); assert.equal(appointmentWrites, 4, 'Explicit replacement can create a new appointment');
    assert.equal((await agenda.save({ ...request, explicit_new_follow_up: true })).status, 200); assert.equal(appointmentWrites, 4);
    traces.find(t => t.id_tracing === free.id_tracing).status = 'cancelled';
    assert.equal((await agenda.save(request)).status, 400); traces.find(t => t.id_tracing === free.id_tracing).status = 'active';
    assert.equal((await agenda.save({ ...request, appointment: { ...appointment, followUpId: 'foreign-followup' } })).status, 403);

    // Exact lookup stays independent of the newest 50 history rows, with tenant/patient isolation.
    for (let i = 0; i < 70; i++) appointments.push({ ...appointment, id: uuid(), business: body.id_business, followUpId: `unrelated-${i}`, date: '2027-01-01', status: 'cancelled' });
    appointments.push({ ...appointment, id: uuid(), business: 'foreign-clinic', followUpId: free.id_tracing });
    appointments.push({ ...appointment, id: uuid(), business: body.id_business, patientId: 'other-patient', followUpId: free.id_tracing });
    result = await agenda.patientHistory({ ...body, follow_up_id: free.id_tracing, limit: 50 });
    assert.equal(result.status, 200); assert.equal(result.data.appointments.length, 2);
    assert.ok(result.data.appointments.every(a => a.followUpId === free.id_tracing && a.patientId === body.id_person && a.business === body.id_business));
    for (let i = 0; i < 20; i++) appointments.push({ ...appointment, id: uuid(), business: body.id_business, date: '2027-02-01', status: 'cancelled' });
    result = await agenda.patientHistory({ ...body, follow_up_id: free.id_tracing, active_only: 'true', limit: 2 });
    assert.equal(result.status, 200); assert.equal(result.data.appointments.length, 1);
    assert.equal(result.data.appointments[0].status, 'pending_confirmation', 'An older open link is not hidden behind terminal history pagination');
    result = await agenda.patientHistory({ ...body, upcoming_from: '2026-10-14', limit: 1 });
    assert.equal(result.status, 200); assert.equal(result.data.appointments.length, 1); assert.equal(result.data.appointments[0].date, '2026-10-20');
    assert.equal(result.data.appointments[0].status, 'pending_confirmation');
    result = await agenda.patientHistory({ ...body, upcoming_from: '2026-10-20', upcoming_time: '10:00', limit: 1 });
    assert.equal(result.status, 200); assert.equal(result.data.appointments.length, 0, 'A slot earlier today is not the next appointment');
    appointments.push({ ...appointment, id: uuid(), business: body.id_business, startTime: '10:00', endTime: '10:30' });
    appointments.push({ ...appointment, id: uuid(), business: body.id_business, startTime: '11:00', endTime: '11:30' });
    result = await agenda.patientHistory({ ...body, upcoming_from: '2026-10-20', upcoming_time: '10:00', limit: 1 });
    assert.equal(result.status, 200); assert.equal(result.data.appointments[0].startTime, '11:00',
        'At 10:00:30 the current-minute slot is already started and cannot hide the later appointment behind LIMIT 1');
    assert.equal((await agenda.patientHistory({ ...body, upcoming_from: '2026-10-14', upcoming_time: '25:00' })).status, 400);
    assert.equal((await agenda.patientHistory({ ...body, upcoming_from: '2026-02-30' })).status, 400);
    assert.equal((await agenda.patientHistory({ ...body, id_business: 'foreign-clinic' })).status, 403);
    const origin = { ...appointment, id: uuid(), business: body.id_business, revision: 1, status: 'confirmed' };
    appointments.push(origin);
    result = await agenda.reschedule({ ...body, request_id: uuid(), appointment: { ...origin, date: '2026-10-28', title: 'Motivo actualizado desde agenda' } });
    assert.equal(result.status, 409); assert.equal(result.data.code, 'FOLLOW_UP_APPOINTMENT_AMBIGUOUS');
    // The preceding history fixtures intentionally contain multiple open bookings.
    for (const a of appointments) if (a.id !== origin.id && a.business === body.id_business && a.patientId === origin.patientId && a.followUpId === origin.followUpId && ['pending_confirmation','confirmed'].includes(a.status)) a.status = 'cancelled';
    result = await agenda.reschedule({ ...body, request_id: uuid(), appointment: { ...origin, date: '2026-10-28', title: 'Motivo actualizado desde agenda' } });
    assert.equal(result.status, 200, result.message);
    const moved = result.data[0];
    assert.equal(moved.followUpId, origin.followUpId, 'Reprogramming preserves exact follow-up link despite changed date and reason');
    assert.equal(moved.rescheduledFromAppointmentId, origin.id);
    result = await agenda.save({ ...body, appointment: { ...moved, status: 'confirmed' } });
    assert.equal(result.status, 200, result.message);
    assert.equal(result.data[0].followUpId, origin.followUpId);
    assert.equal(result.data[0].status, 'confirmed');
    console.log('PASS CO14: free procedure, immutable validated plan link, no inferred treatment transition, idempotent follow-up/appointment retries, changed-payload conflicts, terminal appointment preservation, explicit replacement, exact/paginated and upcoming appointment scopes. Real DAOs with simulated SQL; no DB connection or live writes.');
})().catch(error => { console.error(error); process.exitCode = 1; });

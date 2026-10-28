'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createFixture } = require('./co25-a2-mysql-fixture');
async function run(f) {
    const checks = [], originalNow = Date.now;
    const pass = name => { checks.push(name); console.log('PASS ' + name); };
    const { dao, query, body } = f;
    let now = Date.parse('2030-01-01T16:00:00Z'); Date.now = () => now;
    const base = { doctorProfileId: 'qa-doctor', patientId: 'qa-patient', patientName: 'Paciente Sintetico', contactPhone: '+525550000000', date: '2030-01-02', startTime: '09:00', endTime: '09:30', status: 'confirmed', source: 'qa_co25' };
    const save = (appointment, extra = {}) => dao.save({ ...body, request_id: randomUUID(), appointment, ...extra });
    const good = result => { assert.equal(result.status, 200, result.message); return result.data[0]; };
    const reject = (result, code) => { assert.equal(result.data && result.data.code, code, result.message); assert.ok(result.status >= 400); };
    const get = async id => (await dao.get({ ...body, id_appointment: id })).data;
    // A2 must still handle legacy duplicate reservations. A4 forbids creating them via the API.
    const seedLegacyLinked = async appointment => {
        const row = good(await save({ ...appointment, followUpId: null }));
        await query('UPDATE appointment SET id_tracing=:trace WHERE id_appointment=:id', { trace: appointment.followUpId, id: row.id });
        return { ...row, followUpId: appointment.followUpId };
    };
    try {
        const Module = require('node:module');
        const sourcePath = path.resolve(__dirname, '../../src/domain/appointments/safeWrites.js');
        const baseline = new Module(sourcePath); baseline.filename = sourcePath; baseline.paths = Module._nodeModulePaths(path.dirname(sourcePath));
        baseline._compile(require('node:child_process').execFileSync('git', ['show', 'HEAD:src/domain/appointments/safeWrites.js'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }), sourcePath);
        const before = await baseline.exports.write(dao, { ...body, request_id: randomUUID(), appointment: { ...base, date: '2030-02-01', status: 'completed' } });
        assert.equal(before.status, 200, 'Baseline must reproduce future completion');
        assert.equal((await baseline.exports.write(dao, { ...body, request_id: randomUUID(), appointment: { ...before.data[0], status: 'cancelled' } })).status, 200, 'Baseline must reproduce cancellation without reason');
        pass('HEAD baseline reproduced future completion and cancellation without reason in the isolated database');
        for (const status of ['completed', 'no_show', 'cancelled']) reject(await save({ ...base, status, cancellationReason: 'QA' }), 'APPOINTMENT_NOT_STARTED');
        let a = good(await save(base));
        for (const status of ['completed', 'no_show']) reject(await save({ ...a, status }), 'APPOINTMENT_NOT_STARTED');
        pass('future creation and final-state transitions rejected through real DAO/MySQL');
        await query("UPDATE appointment SET appointment_date='2029-12-31' WHERE id_appointment=:id", { id: a.id });
        a = good(await save({ ...await get(a.id), status: 'completed' }));
        reject(await save({ ...a, date: '2030-01-03' }), 'APPOINTMENT_NOT_STARTED');
        await query("UPDATE appointment SET appointment_date='2030-01-03' WHERE id_appointment=:id", { id: a.id });
        a = good(await save({ ...await get(a.id), description: 'Legacy note remains editable' }));
        a = good(await save({ ...a, date: '2029-12-31' }));
        pass('completed future move rejected, inconsistent historical note preserved, temporal correction allowed');

        let closed = good(await save({ ...base, startTime: '10:00', endTime: '10:30' }));
        await query('UPDATE appointment_config SET enabled=0');
        await query('UPDATE doctor_professional_profile SET is_active=0');
        await query('UPDATE person SET active=0');
        reject(await save({ ...closed, status: 'cancelled' }), 'CANCELLATION_REASON_REQUIRED');
        closed = good(await save({ ...closed, status: 'cancelled', cancellationReasonCode: 'patient_cancelled', cancellationReason: 'PRIVATE_CANCEL_TEXT' }));
        assert.equal(closed.status, 'cancelled'); assert.match(closed.cancellationReason, /El paciente canceló/);
        const audit = await query('SELECT changes FROM appointment_audit WHERE appointment_id=:id ORDER BY id DESC LIMIT 1', { id: closed.id });
        const json = JSON.stringify(audit); assert.match(json, /patient_cancelled/); assert.doesNotMatch(json, /PRIVATE_CANCEL_TEXT/);
        await query('UPDATE appointment_config SET enabled=1'); await query('UPDATE doctor_professional_profile SET is_active=1');
        await query('UPDATE person SET active=1');
        pass('reason required on closed agenda; inactive doctor cancellation permitted; audit stores category without private detail');

        let legacy = good(await save({ ...base, startTime: '11:00', endTime: '11:30' }));
        reject(await dao.delete({ ...body, id_appointment: legacy.id, revision: legacy.revision }), 'CANCELLATION_REASON_REQUIRED');
        const intent = { ...body, id_appointment: legacy.id, revision: legacy.revision, request_id: randomUUID(), cancellationReason: 'Legacy reason' };
        legacy = good(await dao.delete(intent)); assert.equal(good(await dao.delete(intent)).id, legacy.id);
        await query('UPDATE appointment SET cancellation_reason=NULL WHERE id_appointment=:id', { id: legacy.id });
        const blank = good(await save({ ...await get(legacy.id), description: 'Historical blank preserved' }));
        const corrected = good(await save({ ...blank, date: '2029-12-30' }));
        assert.equal(corrected.cancellationReason, null);
        assert.equal(corrected.date, '2029-12-30');
        pass('legacy DELETE requires a reason, replays the same receipt, and historical empty reason is not rewritten');

        const receiptBody = { ...base, startTime: '12:00', endTime: '12:30', status: 'completed' };
        const legacyId = randomUUID(), oldKey = randomUUID();
        await query("INSERT INTO appointment(id_appointment,id_business,doctor_profile_id,id_person,appointment_date,start_time,end_time,status) VALUES(:id,'qa-clinic','qa-doctor','qa-patient','2030-01-02','12:00','12:30','completed')", { id: legacyId });
        const keys = ['id','revision','doctorProfileId','doctorName','patientId','patientName','contactPhone','followUpId','date','startTime','endTime','status','title','description','source','cancellationReason','rescheduledFromAppointmentId','rescheduledToAppointmentId'];
        const dto = Object.fromEntries(keys.map(k => [k, receiptBody[k] || null]));
        const hash = createHash('sha256').update(JSON.stringify({ dto, sync: false, explicitNew: false })).digest('hex');
        await query("INSERT INTO appointment_write_request(id_business,request_id,actor_id,operation,payload_hash,appointment_id) VALUES('qa-clinic',:key,'qa-actor','save',:hash,:id)", { key: oldKey, hash, id: legacyId });
        assert.equal(good(await save(receiptBody, { request_id: oldKey })).id, legacyId);
        pass('pre-A2 hash receipt returns before new temporal validation');

        let linked = await seedLegacyLinked({ ...base, startTime: '13:00', endTime: '13:30', followUpId: 'qa-trace' });
        const preview = await dao.cancellationImpact({ ...body, id_appointment: linked.id, revision: linked.revision });
        assert.equal(preview.data.state, 'uncovered_overdue'); assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_CLINICAL/);
        const other = await seedLegacyLinked({ ...base, startTime: '14:00', endTime: '14:30', followUpId: 'qa-trace' });
        const cancellation = await save({ ...linked, status: 'cancelled', cancellationReasonCode: 'entry_error', cancellationImpactToken: preview.data.token });
        good(cancellation); assert.equal(cancellation.cancellationImpact.state, 'covered'); assert.equal(cancellation.cancellationImpact.changedSincePreview, true);
        const results = await Promise.all([0, 1].map(() => save({ ...other, status: 'cancelled', cancellationReasonCode: 'patient_cancelled' })));
        assert.equal(results.filter(r => r.status === 200).length, 1); assert.equal(results.filter(r => r.status === 409).length, 1);
        assert.equal(results.find(r => r.status === 200).cancellationImpact.state, 'uncovered_overdue');
        const raceA = await seedLegacyLinked({ ...base, date: '2030-01-03', startTime: '10:00', endTime: '10:30', followUpId: 'qa-trace' });
        const raceB = await seedLegacyLinked({ ...base, date: '2030-01-03', startTime: '11:00', endTime: '11:30', followUpId: 'qa-trace' });
        const race = await Promise.all([raceA, raceB].map(appointment => save({ ...appointment, status: 'cancelled', cancellationReasonCode: 'patient_cancelled' })));
        race.forEach(good); assert.deepEqual(race.map(r => r.cancellationImpact.state).sort(), ['covered', 'uncovered_overdue']);
        assert.equal((await query("SELECT status FROM tracing WHERE id_tracing='qa-trace'"))[0].status, 'active');
        pass('preview vs committed coverage, simultaneous cancellation revisions, no clinical projection and no tracing mutation');

        const tenant = await dao.cancellationImpact({ ...body, id_business: 'other-clinic', id_appointment: linked.id, revision: 1 });
        assert.equal(tenant.status, 403);
        let noshow = good(await save({ ...base, date: '2029-12-31', startTime: '15:00', endTime: '15:30' }));
        await query('UPDATE doctor_professional_profile SET is_active=0');
        noshow = good(await save({ ...noshow, status: 'no_show' }));
        await query('UPDATE doctor_professional_profile SET is_active=1');
        reject(await save({ ...noshow, date: '2030-01-03' }), 'APPOINTMENT_NOT_STARTED');
        const rescheduled = good(await dao.reschedule({ ...body, request_id: randomUUID(), appointment: { ...a, date: '2030-01-04' } }));
        assert.equal(rescheduled.status, 'pending_confirmation'); assert.equal(rescheduled.rescheduledFromAppointmentId, a.id);
        pass('tenant denial, past no-show closing with inactive doctor, no-show future correction blocked and atomic reschedule preserved');
        const key = randomUUID();
        const reasonRow = good(await save({ ...base, date: '2030-01-05' }));
        const cancelIntent = { ...reasonRow, status: 'cancelled', cancellationReasonCode: 'entry_error' };
        good(await save(cancelIntent, { request_id: key }));
        good(await save(cancelIntent, { request_id: key }));
        reject(await save({ ...cancelIntent, cancellationReasonCode: 'other', cancellationReason: 'Changed' }, { request_id: key }), 'REQUEST_REUSED');
        await query("UPDATE appointment_config SET timezone='invalid'");
        reject(await save({ ...base, date: '2030-01-06' }), 'INVALID_CLINIC_TIMEZONE');
        await query("UPDATE appointment_config SET timezone='America/Mexico_City'");
        const early = good(await save({ ...base, date: '2030-01-01', startTime: '09:30', endTime: '11:30', status: 'completed' }));
        assert.equal(early.status, 'completed');
        pass('new receipt category conflicts, invalid clinic zone rejection and explicit closure after start but before end');
        await query("UPDATE tracing SET quote_date_after='2030-01-04'");
        const upcoming = await seedLegacyLinked({ ...base, date: '2030-01-04', startTime: '19:00', endTime: '19:30', followUpId: 'qa-trace' });
        const beforeArchive = await dao.cancellationImpact({ ...body, id_appointment: upcoming.id, revision: upcoming.revision });
        assert.equal(beforeArchive.data.state, 'uncovered_upcoming');
        await query('UPDATE person SET active=0');
        const archivedCancel = await save({ ...upcoming, status: 'cancelled', cancellationReasonCode: 'doctor_unavailable', cancellationImpactToken: beforeArchive.data.token });
        good(archivedCancel); assert.equal(archivedCancel.cancellationImpact.state, 'inactive'); assert.equal(archivedCancel.cancellationImpact.changedSincePreview, true);
        await query('UPDATE person SET active=1');
        await query("UPDATE appointment_config SET timezone='America/Tijuana' WHERE doctor_profile_id IS NULL");
        for (const [date, startTime, endTime] of [['2030-03-10', '02:00', '02:30'], ['2030-11-03', '01:00', '01:30']]) reject(await save({ ...base, date, startTime, endTime }), 'INVALID_LOCAL_TIME');
        pass('upcoming coverage remains distinct from overdue, archived patient cancellation recalculates impact and DST gap/fold reject through SQL');
        return checks;
    } finally { Date.now = originalNow; }
}
if (require.main === module) (async () => {
    const f = await createFixture();
    try {
        const checks = await run(f);
        const out = path.resolve(__dirname, '../../../docs/clinical-operations/evidence/CO25/' + (process.env.CO25_QA_EVIDENCE_PREFIX || 'a2') + '-mysql-results.json');
        fs.writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), mysql: f.version, port: f.port, database: 'qa_co25_a2', syntheticOnly: true, checks }, null, 2));
    } finally { await f.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run };

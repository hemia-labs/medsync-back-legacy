'use strict';
const assert = require('node:assert/strict');
const p = require('../../src/domain/appointments/writePolicy');
const { summarize } = require('../../src/domain/appointments/cancellationImpact');
const zone = 'America/Mexico_City', now = Date.parse('2030-01-01T16:00:00Z');
const future = { date: '2030-01-01', startTime: '11:00', endTime: '11:30', status: 'confirmed' };
let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }
test('creation and final-state transitions use clinic start, not end or machine timezone', () => {
    for (const status of ['completed', 'no_show', 'cancelled']) assert.equal(p.temporal({ ...future, status }, null, zone, now).data.code, 'APPOINTMENT_NOT_STARTED');
    for (const status of ['pending_confirmation', 'confirmed']) assert.equal(p.temporal({ ...future, status }, null, zone, now), null);
    for (const status of ['completed', 'no_show']) {
        assert.ok(p.temporal({ ...future, status }, future, zone, now));
        assert.equal(p.temporal({ ...future, startTime: '09:30', status }, future, zone, now), null);
    }
    assert.equal(p.temporal({ ...future, status: 'cancelled' }, future, 'invalid', now), null);
});
test('moving a completed/no-show appointment revalidates, unchanged legacy notes remain editable', () => {
    for (const status of ['completed', 'no_show']) {
        const past = { ...future, status, date: '2029-12-31' }, legacy = { ...future, status };
        assert.ok(p.temporal({ ...past, date: future.date }, past, zone, now));
        assert.equal(p.temporal({ ...legacy, description: 'synthetic edit' }, legacy, 'invalid', now), null);
        assert.equal(p.temporal(past, legacy, zone, now), null);
    }
});
test('invalid timezone and DST nonexistent/ambiguous walls reject without fallback', () => {
    assert.equal(p.temporal(future, null, 'invalid', now).data.code, 'INVALID_CLINIC_TIMEZONE');
    for (const [date, startTime, endTime] of [['2030-03-10', '02:00', '02:30'], ['2030-11-03', '01:00', '01:30']]) {
        assert.equal(p.temporal({ ...future, date, startTime, endTime }, null, 'America/Tijuana', now).data.code, 'INVALID_LOCAL_TIME');
    }
    const border = { ...future, date: '2029-12-31', startTime: '23:30', endTime: '23:59', status: 'completed' };
    assert.ok(p.temporal(border, null, zone, Date.parse('2030-01-01T05:15:00Z')));
});
test('uniform reasons, legacy compatibility, category limits and untouched historical blanks', () => {
    const a = { ...future, status: 'cancelled' };
    assert.equal(p.cancellation(a, future).error.data.code, 'CANCELLATION_REASON_REQUIRED');
    assert.ok(p.cancellation({ ...a, cancellationReasonCode: 'other', cancellationReason: '   ' }, future).error);
    assert.ok(p.cancellation({ ...a, cancellationReasonCode: 'forged' }, future).error);
    assert.ok(p.cancellation({ ...a, cancellationReasonCode: 'patient_cancelled', cancellationReason: 'x'.repeat(1000) }, future).error);
    assert.equal(p.cancellation({ ...a, cancellationReason: ' legacy reason ' }, future).appointment.cancellationReason, 'legacy reason');
    assert.equal(p.cancellation({ ...a, cancellationReasonCode: 'patient_cancelled' }, future).code, 'patient_cancelled');
    assert.equal(p.cancellation(a, a).error, undefined);
});
test('coverage follows existing Pulse semantics, with archived/uncertain/overdue distinctions', () => {
    const a = { ...future, id: 'a', followUpId: 't' }, t = { status: 'active', patientActive: 1, dueDate: '2029-12-31' };
    assert.equal(summarize(a, t, [a], '2030-01-01').state, 'uncovered_overdue');
    assert.equal(summarize(a, t, [a, { ...a, id: 'b' }], '2030-01-01').state, 'covered');
    assert.equal(summarize(a, { ...t, dueDate: '2030-01-01' }, [a], '2030-01-01').state, 'uncovered_upcoming');
    assert.equal(summarize(a, { ...t, patientActive: 0 }, [a], '2030-01-01').state, 'inactive');
    assert.equal(summarize(a, t, [a, { ...a, id: 'b', status: 'unknown' }], '2030-01-01').state, 'unknown');
    assert.equal(summarize(a, { ...t, dueDate: '0999-12-31' }, [a], '2030-01-01').state, 'unknown');
});
console.log('PASS CO25 A2 policy: ' + count + ' groups');

'use strict';
// One MySQL connection; every table is temporary and shadows the persistent table.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { injectReplacements } = require('sequelize/lib/utils/sql');
const config = require('../../src/config/config');
const { followUpCalendar } = require('../../src/util/dashboardFollowUpCalendar');
const dialect = { name: 'mysql', TICK_CHAR_LEFT: '`', TICK_CHAR_RIGHT: '`', canBackslashEscape: () => true, supports: {} };
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const range = { from: '2020-01-01', to: '2020-01-31' };
const actor = { actorLoginId: 'synthetic-doctor' };
const access = { families: { administrative: true, clinical: true, financial: true }, administrativeTeam: true,
    scope: { mode: 'tenant', doctorProfileId: null, idLogin: null, label: 'Todo el consultorio' } };
const schemas = {
    person: 'id_person VARCHAR(80), id_business VARCHAR(80), created_at DATETIME',
    appointment: `id_appointment VARCHAR(80), id_business VARCHAR(80), id_person VARCHAR(80), doctor_profile_id VARCHAR(80),
        id_tracing VARCHAR(80), active INT DEFAULT 1, appointment_date DATE, start_time TIME DEFAULT '10:00:00', status VARCHAR(40), created_at DATETIME`,
    prescription: `id_business VARCHAR(80), issuer_doctor_profile_id VARCHAR(80), issuer_doctor_id VARCHAR(80), active INT DEFAULT 1,
        status VARCHAR(40), created_at DATETIME, issued_at DATETIME, issue_date DATE`,
    clinical_histories: `business_id VARCHAR(80), doctor_responsible_profile_id VARCHAR(80), doctor_responsible_user_id VARCHAR(80),
        deleted_at DATETIME, status VARCHAR(40), created_at DATETIME, finalized_at DATETIME`,
    tracing: 'id_tracing VARCHAR(80), id_business VARCHAR(80), id_person VARCHAR(80), status VARCHAR(40), quote_date_after DATE',
    appointment_config: `id_appointment_config VARCHAR(80), id_business VARCHAR(80), doctor_profile_id VARCHAR(80),
        timezone VARCHAR(80), active INT DEFAULT 1, created_at DATETIME`,
    treatment_plan: 'id_treatment_plan VARCHAR(80), id_business VARCHAR(80), active INT DEFAULT 1',
    patient_treatment: `id_business VARCHAR(80), id_person VARCHAR(80), id_treatment_plan VARCHAR(80),
        active INT DEFAULT 1, status VARCHAR(40), cost DECIMAL(12,2), created_at DATETIME`
};
// MySQL cannot reference a temporary table twice in one query. Keep an identical
// temporary copy for the retention subquery; only that table name is substituted.
schemas.ux17_later_appointment = schemas.appointment;
(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL,
        user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    const temporary = new Set();
    try {
        for (const [table, schema] of Object.entries(schemas)) {
            await connection.query(`CREATE TEMPORARY TABLE \`${table}\` (${schema}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
            temporary.add(table);
        }
        const insert = async (table, row) => {
            assert.ok(temporary.has(table));
            const keys = Object.keys(row);
            for (const target of table === 'appointment' ? ['appointment', 'ux17_later_appointment'] : [table]) {
                await connection.query(`INSERT INTO \`${target}\` (${keys.map(key => '\`' + key + '\`').join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(row));
            }
        };
        stub('../../src/db/Sequelize.connection', { async query(sql, options) {
            sql = sql.replace(/\bFROM appointment later_appointment\b/g, 'FROM ux17_later_appointment later_appointment');
            assert.match(sql, /^\s*SELECT\b/i, 'DAO performs reads only');
            for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\b/gi)) {
                assert.ok(temporary.has(match[1]), 'SQL cannot read a persistent table: ' + match[1]);
            }
            const [rows] = await connection.query(injectReplacements(sql, dialect, options.replacements));
            return rows;
        } });
        stub('../../src/util/dashboardAccess', { resolveDashboardAccess: async () => access, PERMISSIONS: {} });
        stub('../../src/util/planFeatures', { assertPlanFeature: async () => ({ license: { plan: { code: 'pro' }, business: {}, limits: {} } }) });
        const dao = require('../../src/Dao/mysql/businessDashboard.dao');
        let clock = new Date('2026-10-20T18:00:00Z');
        const readFollowUps = dao.followUpCoverageSummary.bind(dao);
        dao.followUpCoverageSummary = replacements => readFollowUps(replacements, clock);
        const ok = response => { assert.equal(response.status, 200, response.message); return response.data; };
        const run = async () => ok(await dao.operationalSummary('synthetic-tenant', range, actor));
        const empty = await run();
        assert.equal(empty.appointments.total, 0); assert.equal(empty.appointments.scheduled, 0);
        assert.equal(empty.prescriptions.total, 0); assert.equal(empty.clinicalHistories.total, 0);
        for (const key of ['completedRate', 'noShowRate', 'cancelledRate', 'pendingConfirmationRate']) assert.equal(empty.decisionMetrics.appointmentHealth[key], null);
        assert.equal(empty.decisionMetrics.retention.retentionRate, null);
        assert.equal(empty.decisionMetrics.followUps.coverageRate, null);
        assert.equal(empty.decisionMetrics.followUps.overdueWithoutAppointment, 0);
        assert.equal(empty.decisionMetrics.followUps.upcomingWithoutAppointment, 0);
        assert.equal(empty.decisionMetrics.treatmentEconomics.averageTreatmentValuePerPatient, null);
        let appointmentIndex = 0;
        const addAppointment = async (patient, date, status, extra = {}) => insert('appointment', {
            id_appointment: 'synthetic-' + (++appointmentIndex), id_business: 'synthetic-tenant', id_person: patient,
            doctor_profile_id: 'profile-one', appointment_date: date, status, created_at: '2020-01-01 10:00:00', ...extra
        });
        for (const patient of ['p1', 'p2', 'p3', 'p4']) await insert('person', { id_person: patient, id_business: 'synthetic-tenant', created_at: '2020-01-01 10:00:00' });
        await insert('person', { id_person: 'foreign', id_business: 'foreign-tenant', created_at: '2020-01-01 10:00:00' });
        await addAppointment('p1', '2020-01-02', 'completed'); await addAppointment('p1', '2020-01-04', 'completed');
        await addAppointment('p2', '2020-01-03', 'completed', { created_at: '2019-12-20 10:00:00' });
        await addAppointment('p2', '2099-01-01', 'confirmed');
        for (const [date, status] of [['05', 'pending_confirmation'], ['06', 'no_show'], ['07', 'cancelled'], ['08', 'rescheduled']]) await addAppointment('p3', '2020-01-' + date, status);
        await addAppointment('p4', '2019-12-15', 'completed', { created_at: '2019-12-15 10:00:00' });
        await addAppointment('p4', '2020-01-09', 'confirmed', { created_at: '2019-12-15 10:00:00' });
        await addAppointment('p3', '2020-01-10', 'pending_confirmation', { active: 0 });
        await addAppointment('foreign', '2020-01-02', 'pending_confirmation', { id_business: 'foreign-tenant' });
        for (const [id, date, status] of [['t1', '2020-01-15', 'active'], ['t2', '2020-01-16', 'active'], ['t3', '2020-01-17', 'cancelled'], ['t4', '2020-02-01', 'active']]) await insert('tracing', {
            id_tracing: id, id_business: 'synthetic-tenant', id_person: id === 't2' ? 'p2' : id === 't3' ? 'p3' : 'p1', quote_date_after: date, status });
        await addAppointment('p1', '2020-01-15', 'confirmed', { id_tracing: 't1' });
        await addAppointment('p1', '2020-01-16', 'confirmed', { id_tracing: 't1' });
        await addAppointment('p2', '2020-01-16', 'rescheduled', { id_tracing: 't2' });
        await addAppointment('p3', '2020-01-17', 'confirmed', { id_tracing: 't3' });
        const addPrescription = (status, extra = {}) => insert('prescription', { id_business: 'synthetic-tenant', issuer_doctor_profile_id: 'profile-one',
            issuer_doctor_id: 'synthetic-doctor', status, created_at: '2020-01-02 10:00:00', issued_at: '2020-01-03 10:00:00', ...extra });
        await addPrescription('issued'); await addPrescription('draft', { issued_at: null }); await addPrescription('cancelled');
        await addPrescription('issued', { created_at: '2019-12-15 10:00:00' });
        await addPrescription('issued', { active: 0 }); await addPrescription('issued', { id_business: 'foreign-tenant' });
        await addPrescription('issued', { issuer_doctor_profile_id: 'profile-two' });
        const addHistory = (status, extra = {}) => insert('clinical_histories', { business_id: 'synthetic-tenant', doctor_responsible_profile_id: 'profile-one',
            doctor_responsible_user_id: 'synthetic-doctor', status, created_at: '2020-01-01 10:00:00', finalized_at: '2020-01-05 10:00:00', ...extra });
        await addHistory('FINALIZED'); await addHistory('DRAFT', { finalized_at: null });
        await addHistory('FINALIZED', { created_at: '2019-12-15 10:00:00' });
        await addHistory('FINALIZED', { deleted_at: '2020-01-10 10:00:00' });
        await addHistory('FINALIZED', { doctor_responsible_profile_id: 'profile-two' });
        for (const [id, active] of [['plan', 1], ['inactive-plan', 0]]) await insert('treatment_plan', { id_treatment_plan: id, id_business: 'synthetic-tenant', active });
        for (const [patient, cost, extra] of [['p1', 100, {}], ['p1', 50, {}], ['p2', 50, {}], ['p1', 999, { status: 'cancelled' }],
            ['p1', 999, { id_treatment_plan: 'inactive-plan' }], ['p1', 999, { active: 0 }], ['p1', null, {}], ['p1', -20, {}]]) {
            await insert('patient_treatment', { id_business: 'synthetic-tenant', id_person: patient, id_treatment_plan: 'plan', cost,
                status: 'pending', created_at: '2020-01-01 10:00:00', ...extra });
        }
        const active = await run();
        assert.equal(active.appointments.total, 11); assert.equal(active.appointments.scheduled, 12);
        assert.equal(active.appointments.byStatus.reduce((sum, item) => sum + item.count, 0), 12);
        assert.equal(active.decisionMetrics.appointmentHealth.completedRate, 25);
        for (const key of ['noShowRate', 'cancelledRate', 'pendingConfirmationRate']) assert.equal(active.decisionMetrics.appointmentHealth[key], 8.33);
        assert.equal(active.prescriptions.total, 4); assert.equal(active.prescriptions.drafts, 1); assert.equal(active.prescriptions.cancelled, 1);
        assert.equal(active.clinicalHistories.total, 3); assert.equal(active.clinicalHistories.pending, 1);
        assert.equal(active.periodComparison.prescriptionsIssued.current, 3); assert.equal(active.periodComparison.clinicalHistoriesFinalized.current, 3);
        assert.deepEqual(active.periodComparison.appointmentsCreated, { current: 11, previous: 3, delta: 8, deltaPercent: 266.67 });
        assert.equal(active.decisionMetrics.retention.firstVisitPatients, 2); assert.equal(active.decisionMetrics.retention.retainedPatients, 1);
        assert.equal(active.decisionMetrics.retention.retentionRate, 50);
        assert.equal(active.decisionMetrics.followUps.due, 2); assert.equal(active.decisionMetrics.followUps.scheduled, 1);
        assert.equal(active.decisionMetrics.followUps.coverageRate, 50);
        assert.equal(active.decisionMetrics.followUps.overdueWithoutAppointment, 1);
        assert.equal(active.decisionMetrics.followUps.upcomingWithoutAppointment, 0);
        assert.equal(active.decisionMetrics.treatmentEconomics.totalEstimatedTreatmentValue, 200);
        assert.equal(active.decisionMetrics.treatmentEconomics.averageTreatmentValuePerPatient, 100);
        assert.equal(active.decisionMetrics.treatmentEconomics.patientsWithEstimatedTreatment, 2);
        assert.equal(active.decisionMetrics.treatmentEconomics.treatmentItemsWithCost, 3);
        const trend = ok(await dao.trends('synthetic-tenant', { ...range, granularity: 'month' }, actor)).series[0];
        assert.equal(trend.appointmentsCreated, 11); assert.equal(trend.appointmentsScheduled, 12);
        assert.equal(trend.prescriptionsIssued, 3); assert.equal(trend.clinicalHistoriesFinalized, 3);
        access.scope = { mode: 'own', doctorProfileId: 'profile-one', idLogin: 'synthetic-doctor' };
        const own = await run();
        assert.equal(own.periodComparison.prescriptionsIssued.current, 2); assert.equal(own.periodComparison.clinicalHistoriesFinalized.current, 2);
        assert.equal(own.periodComparison.patientsCreated, null); assert.equal(own.decisionMetrics.followUps.available, false);
        assert.equal(own.decisionMetrics.followUps.due, null); assert.equal(own.decisionMetrics.treatmentEconomics.available, false);
        assert.equal(own.decisionMetrics.followUps.overdueWithoutAppointment, null);
        assert.equal(own.decisionMetrics.followUps.upcomingWithoutAppointment, null);
        access.scope = { mode: 'tenant', doctorProfileId: null, idLogin: null };
        await connection.query("UPDATE appointment SET status='completed' WHERE status IN ('no_show','cancelled','pending_confirmation')");
        await connection.query("UPDATE ux17_later_appointment SET status='completed' WHERE status IN ('no_show','cancelled','pending_confirmation')");
        await connection.query("UPDATE prescription SET status='issued' WHERE status='draft'");
        await connection.query("UPDATE clinical_histories SET status='FINALIZED', finalized_at='2020-01-10 10:00:00' WHERE status='DRAFT'");
        await addAppointment('p2', '2020-01-16', 'confirmed', { id_tracing: 't2' });
        const clear = await run();
        for (const key of ['noShow', 'cancelled', 'pendingConfirmation']) assert.equal(clear.decisionMetrics.appointmentHealth[key], 0);
        assert.equal(clear.clinicalHistories.pending, 0); assert.equal(clear.prescriptions.drafts, 0);
        assert.equal(clear.decisionMetrics.followUps.due, clear.decisionMetrics.followUps.scheduled);
        assert.equal(clear.decisionMetrics.followUps.overdueWithoutAppointment, 0);
        assert.equal(clear.decisionMetrics.followUps.upcomingWithoutAppointment, 0);
        // UX18: fixed business-local day, period boundaries, statuses, patient/tenant isolation.
        assert.deepEqual(followUpCalendar('America/Mexico_City', new Date('2020-01-16T05:59:59Z')), { asOfDate: '2020-01-15', timeZone: 'America/Mexico_City' });
        assert.equal(followUpCalendar('America/Mexico_City', new Date('2020-01-16T06:00:00Z')).asOfDate, '2020-01-16');
        assert.equal(followUpCalendar('America/Tijuana', new Date('2020-01-16T07:59:59Z')).asOfDate, '2020-01-15');
        assert.equal(followUpCalendar('Asia/Tokyo', new Date('2020-01-16T15:00:00Z')).asOfDate, '2020-01-17');
        assert.equal(followUpCalendar('invalid-zone', new Date('2020-01-16T06:00:00Z')).timeZone, 'America/Mexico_City');
        clock = new Date('2020-01-16T12:00:00Z');
        await insert('appointment_config', { id_appointment_config: 'business-calendar', id_business: 'boundary-tenant', timezone: 'America/Mexico_City', created_at: '2020-01-01 00:00:00' });
        await insert('appointment_config', { id_appointment_config: 'doctor-calendar', id_business: 'boundary-tenant', doctor_profile_id: 'profile-one', timezone: 'Asia/Tokyo', created_at: '2020-01-02 00:00:00' });
        await insert('appointment_config', { id_appointment_config: 'inactive-calendar', id_business: 'boundary-tenant', timezone: 'UTC', active: 0, created_at: '2020-01-03 00:00:00' });
        const followUp = (id, date, extra = {}) => insert('tracing', { id_tracing: id, id_business: 'boundary-tenant', id_person: 'shared-patient', status: 'active', quote_date_after: date, ...extra });
        for (const [id, date] of [['past-missing', '15'], ['today-missing', '16'], ['future-missing', '17'], ['past-covered', '14'],
            ['past-cancelled', '13'], ['past-no-show', '12'], ['past-rescheduled', '11'], ['past-inactive', '10'], ['past-too-early', '09'],
            ['past-later-covered', '08'], ['future-covered', '18'], ['today-covered', '16'], ['past-other-patient', '07'], ['past-foreign-link', '06'],
            ['edge-start', '01'], ['edge-end', '31']]) await followUp(id, '2020-01-' + date);
        await followUp('outside-left', '2019-12-31'); await followUp('outside-right', '2020-02-01'); await followUp('no-date', null);
        await followUp('cancelled-follow-up', '2020-01-15', { status: 'cancelled' });
        await followUp('foreign-follow-up', '2020-01-15', { id_business: 'foreign-tenant' });
        const link = (id, date, status = 'confirmed', extra = {}) => addAppointment('shared-patient', date, status,
            { id_business: 'boundary-tenant', id_tracing: id, ...extra });
        await link('past-covered', '2020-01-14'); await link('past-covered', '2020-01-15');
        await link('past-cancelled', '2020-01-13', 'cancelled'); await link('past-no-show', '2020-01-12', 'no_show');
        await link('past-rescheduled', '2020-01-11', 'rescheduled'); await link('past-inactive', '2020-01-10', 'confirmed', { active: 0 });
        await link('past-too-early', '2020-01-08'); await link('past-later-covered', '2020-02-01');
        await link('future-covered', '2020-01-18', 'pending_confirmation'); await link('today-covered', '2020-01-16', 'completed');
        await addAppointment('wrong-patient', '2020-01-07', 'confirmed', { id_business: 'boundary-tenant', id_tracing: 'past-other-patient' });
        await link('past-foreign-link', '2020-01-06', 'confirmed', { id_business: 'foreign-tenant' });
        const boundary = ok(await dao.operationalSummary('boundary-tenant', range, actor));
        const split = boundary.decisionMetrics.followUps;
        assert.equal(split.asOfDate, '2020-01-16'); assert.equal(split.timeZone, 'America/Mexico_City');
        assert.equal(split.due, 16); assert.equal(split.scheduled, 4); assert.equal(split.coverageRate, 25);
        assert.equal(split.overdueWithoutAppointment, 9); assert.equal(split.upcomingWithoutAppointment, 3);
        assert.equal(split.due, split.scheduled + split.overdueWithoutAppointment + split.upcomingWithoutAppointment, 'Every follow-up belongs to exactly one bucket');
        const boundaryRange = { _id_business: 'boundary-tenant', _from_date: range.from, _to_date: range.to };
        const beforeMidnight = (await readFollowUps(boundaryRange, new Date('2020-01-16T05:59:59Z')))[0];
        assert.equal(beforeMidnight.asOfDate, '2020-01-15');
        assert.equal(beforeMidnight.overdueWithoutAppointment, 8); assert.equal(beforeMidnight.upcomingWithoutAppointment, 4);
        await connection.query("UPDATE appointment_config SET timezone='Asia/Tokyo' WHERE id_appointment_config='business-calendar'");
        const otherZone = (await readFollowUps(boundaryRange, new Date('2020-01-16T16:00:00Z')))[0];
        assert.equal(otherZone.asOfDate, '2020-01-17'); assert.equal(otherZone.timeZone, 'Asia/Tokyo');
        assert.equal(otherZone.overdueWithoutAppointment, 10); assert.equal(otherZone.upcomingWithoutAppointment, 2);
        await connection.query("UPDATE appointment_config SET timezone='America/Mexico_City' WHERE id_appointment_config='business-calendar'");
        for (const [id, date] of [['today-only', '2020-01-16'], ['tomorrow-only', '2020-01-17']]) await followUp(id, date, { id_business: 'upcoming-only' });
        await followUp('overdue-only', '2020-01-15', { id_business: 'overdue-only' });
        const upcomingOnly = ok(await dao.operationalSummary('upcoming-only', range, actor));
        const overdueOnly = ok(await dao.operationalSummary('overdue-only', range, actor));
        assert.equal(upcomingOnly.decisionMetrics.followUps.overdueWithoutAppointment, 0);
        assert.equal(upcomingOnly.decisionMetrics.followUps.upcomingWithoutAppointment, 2);
        assert.equal(overdueOnly.decisionMetrics.followUps.overdueWithoutAppointment, 1);
        assert.equal(overdueOnly.decisionMetrics.followUps.upcomingWithoutAppointment, 0);
        const outputIndex = process.argv.indexOf('--output');
        if (outputIndex >= 0) {
            const destination = path.resolve(process.argv[outputIndex + 1]);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, JSON.stringify({ empty, active, clear, own, trend, boundary, upcomingOnly, overdueOnly }, null, 2));
        }
        console.log('PASS UX17/UX18 actual MySQL: operational metrics, timezone/midnight boundaries, overdue/today/future follow-ups, deduplication, patient/tenant/status isolation and bucket reconciliation. One connection; temporary tables only; no persistent data read/written.');
    } finally { await connection.end(); }
})().catch(error => { console.error('UX17 MySQL validation failed:', error.code === 'ERR_ASSERTION' ? error.message : error.code || 'Unknown error'); process.exitCode = 1; });

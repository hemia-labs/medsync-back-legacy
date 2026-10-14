// Actual Dashboard SQL, isolated UUID tenants, one connection, all fixture writes rolled back.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { injectReplacements } = require('sequelize/lib/utils/sql');
const { v4: uuid } = require('uuid');
const config = require('../../src/config/config');
const dialect = { name: 'mysql', TICK_CHAR_LEFT: '`', TICK_CHAR_RIGHT: '`', canBackslashEscape: () => true, supports: {} };
const stub = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    const business = uuid(), foreign = uuid(), doctor = uuid(), doctor2 = uuid(), profile = uuid(), profile2 = uuid(), receiver = uuid();
    const range = { from: '2020-01-01', to: '2020-01-31' }, own = { actorLoginId: doctor }, all = { ...range, scope: 'tenant' };
    const observedQueries = [];
    stub('../../src/db/Sequelize.connection', { async query(sql, options = {}) {
        assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|\bCALL\b|\bALTER\b/i);
        observedQueries.push(sql);
        const [rows] = await connection.query(injectReplacements(sql, dialect, options.replacements)); return rows;
    } });
    // Permission persistence is tested by the access migration suite; this suite
    // uses actual actor/profile resolution and metric SQL with controlled grants.
    stub('../../src/util/effectivePermissions', { rows: async id => (id === receiver ? ['dashboard.operations'] : ['dashboard.operations', 'dashboard.clinical', 'dashboard.financial', 'dashboard.scope.all']).map(code => ({ code })) });
    stub('../../src/util/planFeatures', { assertPlanFeature: async () => ({ license: { plan: { code: 'enterprise' }, business: { id_business: business, name: 'QA S17' }, limits: {} } }) });
    const dao = require('../../src/Dao/mysql/businessDashboard.dao');
    const ok = response => { assert.equal(response.status, 200, response.message); return response.data; };
    const insert = async (table, values) => { const fields = Object.keys(values); await connection.query(`INSERT INTO \`${table}\` (${fields.map(key => `\`${key}\``).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, Object.values(values)); };
    try {
        await connection.beginTransaction();
        const [roles] = await connection.query("SELECT id_rol FROM rol WHERE code='doctor' AND active=1 LIMIT 1");
        assert.equal(roles.length, 1, 'Doctor role required for isolated fixture');
        for (const id of [business, foreign]) await insert('business', { id_business: id, name: 'QA S17 ROLLBACK', slug: `qa-s17-${id}`, plan: 'enterprise' });
        for (const id of [doctor, doctor2, receiver]) await insert('login', { id_login: id, id_business: business, id_rol: roles[0].id_rol, name: 'QA S17', active: 1 });
        for (const [id, login] of [[profile, doctor], [profile2, doctor2]]) await insert('doctor_professional_profile', { id_doctor_professional_profile: id, id_business: business, id_login: login, professional_name: `QA S17 ${id}`, is_active: 1 });
        const patients = Array.from({ length: 6 }, () => uuid()), foreignPatient = uuid();
        for (const id of patients) await insert('person', { id_person: id, id_business: business, name: 'QA S17 patient', created_at: '2020-01-01 10:00:00' });
        await insert('person', { id_person: foreignPatient, id_business: foreign, name: 'QA S17 foreign', created_at: '2020-01-01 10:00:00' });
        const appointments = [];
        const appointment = async (patient, date, status = 'completed', doctorProfile = profile, extra = {}) => {
            const row = { id_appointment: uuid(), id_business: business, id_person: patient, doctor_profile_id: doctorProfile,
                appointment_date: date, start_time: '10:00:00', end_time: '10:30:00', status, created_at: '2020-01-01 10:00:00', ...extra };
            await insert('appointment', row); appointments.push(row); return row;
        };
        await appointment(patients[0], '2020-01-02');
        await appointment(patients[0], '2020-01-02', 'completed', profile, { start_time: '11:00:00', end_time: '11:30:00' });
        await appointment(patients[1], '2020-01-05'); await appointment(patients[1], '2099-01-02', 'confirmed');
        await appointment(patients[2], '2020-01-06'); await appointment(patients[2], '2020-01-09', 'confirmed');
        await appointment(patients[3], '2020-01-07'); await appointment(patients[3], '2020-02-01');
        await appointment(patients[4], '2019-12-20'); await appointment(patients[4], '2020-01-10');
        await appointment(patients[5], '2099-01-01');
        await appointment(patients[0], '2020-01-04', 'completed', profile2);
        await appointment(patients[0], '2020-01-08', 'cancelled', null);
        await appointment(foreignPatient, '2020-01-09', 'completed', profile, { id_business: foreign });
        for (const [responsibleProfile, responsibleLogin, status] of [[profile, doctor, 'issued'], [null, doctor, 'issued'], [profile, doctor, 'cancelled'], [profile2, doctor2, 'issued']]) {
            const id = uuid(); await insert('prescription', { id_prescription: id, id_business: business, id_person: patients[0], issuer_doctor_id: responsibleLogin,
                issuer_doctor_profile_id: responsibleProfile, created_by: doctor, issued_by: receiver, folio: id, status, issue_date: '2020-01-02', issued_at: '2020-01-02 10:00:00', created_at: '2020-01-01 10:00:00', doctor_name_snapshot: `QA S17 ${responsibleProfile || profile}` });
        }
        for (const [responsibleProfile, responsibleLogin] of [[profile, doctor], [null, doctor], [profile2, doctor2], [null, null]]) await insert('clinical_histories', {
            id_clinical_history: uuid(), business_id: business, patient_id: patients[0], doctor_responsible_profile_id: responsibleProfile,
            doctor_responsible_user_id: responsibleLogin, created_by_user_id: receiver, finalized_by_user_id: doctor, status: 'FINALIZED',
            clinical_snapshot_json: '{}', responsible_snapshot_json: JSON.stringify({ professional_name: `QA S17 ${responsibleProfile || profile}` }), created_at: '2020-01-01 10:00:00', finalized_at: '2020-01-02 10:00:00'
        });
        const plan = uuid(), plan2 = uuid();
        for (const [id, patient] of [[plan, patients[0]], [plan2, patients[1]]]) await insert('treatment_plan', { id_treatment_plan: id, id_business: business, id_person: patient, title: 'QA S17 plan' });
        for (const [patient, cost, status] of [[patients[0], 100, 'pending'], [patients[1], 50, 'completed'], [patients[0], 999, 'cancelled'], [patients[0], null, 'pending']]) await insert('patient_treatment', {
            id_patient_treatment: uuid(), id_business: business, id_person: patient, id_treatment_plan: patient === patients[0] ? plan : plan2, name: 'QA S17 treatment', cost, status, created_at: '2020-01-01 10:00:00'
        });
        const follow = [uuid(), uuid(), uuid()];
        for (let i = 0; i < follow.length; i++) await insert('tracing', { id_tracing: follow[i], id_business: business, id_person: patients[0], treatment_now: 'QA', treatment_after: 'QA', quote_date_after: '2020-01-15', status: i === 2 ? 'cancelled' : 'active' });
        await appointment(patients[0], '2020-01-15', 'confirmed', profile, { id_tracing: follow[0] });
        await appointment(patients[0], '2020-01-16', 'confirmed', profile, { id_tracing: follow[0] });
        await appointment(patients[0], '2020-01-15', 'rescheduled', profile, { id_tracing: follow[1] });
        await appointment(patients[0], '2020-01-15', 'confirmed', profile, { id_tracing: follow[2] });
        const summary = ok(await dao.summary(business, range, own));
        assert.equal(summary.activity.patientsCreated, null);
        assert.equal(summary.activity.prescriptionsIssued, 2, 'Profile + legacy issuer count for same doctor; other responsible excluded');
        assert.equal(summary.activity.clinicalHistoriesFinalized, 2, 'Author/finalizer cannot substitute responsible doctor');
        const operations = ok(await dao.operationalSummary(business, range, own));
        const expectedAppointments = appointments.filter(row => row.id_business === business && row.doctor_profile_id === profile && row.appointment_date >= range.from && row.appointment_date <= range.to).length;
        assert.equal(operations.appointments.scheduled, expectedAppointments);
        assert.equal(operations.decisionMetrics.retention.firstVisitPatients, 4);
        assert.equal(operations.decisionMetrics.retention.retainedPatients, 1, 'Later completed visit (including same day) counts; confirmed/future/later-period return excluded');
        assert.equal(operations.decisionMetrics.retention.retentionRate, 25);
        const future = ok(await dao.operationalSummary(business, { from: '2099-01-01', to: '2099-01-31' }, own));
        assert.equal(future.decisionMetrics.retention.firstVisitPatients, 0, 'Even a future completed flag cannot create an attended first-visit cohort');
        assert.equal(future.decisionMetrics.retention.retainedPatients, 0);
        assert.equal(future.decisionMetrics.retention.retentionRate, null);
        assert.equal(operations.decisionMetrics.followUps.due, null);
        assert.equal(operations.decisionMetrics.treatmentEconomics.totalEstimatedTreatmentValue, null);
        const tenant = ok(await dao.operationalSummary(business, all, own));
        assert.equal(tenant.decisionMetrics.treatmentEconomics.totalEstimatedTreatmentValue, 150);
        assert.equal(tenant.decisionMetrics.treatmentEconomics.averageTreatmentValuePerPatient, 75);
        assert.equal(tenant.decisionMetrics.treatmentEconomics.revenueAvailable, false);
        assert.equal(tenant.decisionMetrics.followUps.due, 2, 'Canceled follow-up excluded');
        assert.equal(tenant.decisionMetrics.followUps.scheduled, 1, 'Two appointments do not double-count one follow-up; rescheduled excluded');
        const professionals = ok(await dao.professionalBreakdown(business, all, own));
        assert.equal(professionals.items.length, 3, 'Profile and legacy login merge; unidentified responsible remains a separate unassigned row');
        const unassigned = professionals.items.find(row => row.professionalKey === 'unassigned');
        assert.equal(unassigned.clinicalHistoriesFinalized, 1);
        assert.equal(unassigned.label, 'Sin profesional responsable registrado');
        const personal = professionals.items.find(row => row.professionalKey === `profile:${profile}`);
        assert.equal(personal.prescriptionsIssued, 2); assert.equal(personal.clinicalHistoriesFinalized, 2); assert.equal(personal.documentsSigned, null);
        const trend = ok(await dao.trends(business, range, own));
        assert.equal(trend.series[0].prescriptionsIssued, 2); assert.equal(trend.series[0].patientsCreated, null);
        const team = ok(await dao.teamBreakdown(business, all, own)); assert.equal(team.users.active, 3); assert.ok(team.asOf);
        observedQueries.length = 0;
        const reception = ok(await dao.operationalSummary(business, range, { actorLoginId: receiver }));
        assert.equal(reception.clinicalHistories, undefined);
        assert.ok(!observedQueries.some(sql => /FROM (prescription|clinical_histories|patient_treatment|tracing)\b/.test(sql)));
        await connection.rollback();
        const [remaining] = await connection.query('SELECT id_business FROM business WHERE id_business IN (?,?)', [business, foreign]);
        assert.equal(remaining.length, 0, 'UUID tenant fixtures removed by rollback');
        console.log('PASS S17 Dashboard live: isolated tenants/doctors, actual SQL scopes, completed-only same-period return, responsible vs capturist attribution, legacy/profile grouping, canceled and duplicate follow-ups, estimated costs, denied-family reads. One connection; complete rollback verified.');
    } finally { await connection.rollback(); await connection.end(); }
})().catch(error => { console.error('S17 Dashboard live failed:', error.message, error.stack && error.stack.split('\n')[1]); process.exitCode = 1; });

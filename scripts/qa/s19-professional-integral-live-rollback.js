'use strict';
// Actual DAO + SQL integration, not browser E2E. One connection, new dummy rows,
// nested DAO transactions become savepoints; the outer transaction always rolls back.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { injectReplacements } = require('sequelize/lib/utils/sql');
const { v4: uuid } = require('uuid');
const config = require('../../src/config/config');
const dialect = { name: 'mysql', TICK_CHAR_LEFT: '`', TICK_CHAR_RIGHT: '`', canBackslashEscape: () => true, supports: {} };
const ok = (result, label) => { assert.equal(result.status, 200, `${label}: ${result.message}`); return result.data; };
const business = 'QA_BUSINESS_PROFESSIONAL';
const patient = uuid(), reception = uuid(), receptionRole = uuid();
const assistant = uuid(), assistantRole = uuid(), assistantRoleCode = `qa_s19_${assistantRole}`;
const doctorSession = uuid(), receptionSession = uuid(), assistantSession = uuid();
const checks = [];

(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    let serial = 0, failTraceAudit = false;
    const db = {
        async transaction() {
            const name = `s19_${++serial}`;
            await connection.query(`SAVEPOINT ${name}`);
            return { finished: false,
                async commit() { await connection.query(`RELEASE SAVEPOINT ${name}`); this.finished = true; },
                async rollback() { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); this.finished = true; } };
        },
        async query(sql, options = {}) {
            assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE|ALTER|CREATE\s+TABLE)\b/i, 'No schema mutations');
            if (failTraceAudit && /INSERT INTO tracing_revision/.test(sql)) throw new Error('QA forced audit failure');
            const [rows] = await connection.query(injectReplacements(sql, dialect, options.replacements));
            if (/^\s*CALL\b/i.test(sql)) return rows[0];
            return Array.isArray(rows) ? rows : [rows.affectedRows];
        }
    };
    const dbId = require.resolve('../../src/db/Sequelize.connection');
    require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: db };
    try {
        // Fail before any fixture if a called procedure could commit the outer transaction.
        for (const name of ['SP_appointment_save', 'SP_appointment_get', 'SP_appointment_config_get']) {
            const [rows] = await connection.query(`SHOW CREATE PROCEDURE ${name}`);
            assert.doesNotMatch(rows[0]['Create Procedure'], /\b(?:COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i);
        }
        const tables = ['person','rol','login','session','business_role_permission','clinical_histories','clinical_history_events','allergy','patient_allergy_events',
            'document_templates','document_template_versions','patient_documents','patient_document_events','patient_document_signatures','document_signature_requests',
            'prescription','prescription_item','prescription_audit_log','prescription_folio_counter','treatment_plan','patient_treatment','patient_treatment_tooth',
            'tracing','tracing_revision','appointment','appointment_config','appointment_working_day','appointment_time_range'];
        const [engines] = await connection.query('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)',[tables]);
        assert.equal(engines.length,tables.length,'Every required rollback table exists');
        assert.ok(engines.every(row => row.ENGINE === 'InnoDB'), 'All mutated clinical tables must support rollback');
        const [counterBefore] = await connection.query('SELECT folio_year,current_value,updated_at FROM prescription_folio_counter WHERE id_business=? ORDER BY folio_year',[business]);
        await connection.beginTransaction();
        const [profiles] = await connection.query(`SELECT d.* FROM doctor_professional_profile d JOIN login l ON l.id_login=d.id_login AND l.id_business=d.id_business
            WHERE d.id_business=? AND d.is_active=1 AND l.active=1`, [business]);
        assert.equal(profiles.length, 1, 'Professional fixture must have one active doctor');
        const doctor = profiles[0], ctx = { id_business: business, id_login: doctor.id_login }, px = { ...ctx, id_person: patient };
        await connection.query('INSERT INTO rol (id_rol,code,desc_rol,active) VALUES (?,?,?,1)', [receptionRole, `qa_s19_${receptionRole}`, 'QA S19 rollback reception']);
        await connection.query('INSERT INTO login (id_login,id_business,id_rol,name,active) VALUES (?,?,?,?,1)', [reception, business, receptionRole, 'QA S19 reception']);
        await connection.query('INSERT INTO rol (id_rol,code,desc_rol,active) VALUES (?,?,?,1)', [assistantRole, assistantRoleCode, 'QA S19 rollback assistant']);
        await connection.query('INSERT INTO login (id_login,id_business,id_rol,name,active) VALUES (?,?,?,?,1)', [assistant, business, assistantRole, 'QA S19 assistant']);
        for (const [idSession,idLogin] of [[doctorSession,doctor.id_login],[receptionSession,reception],[assistantSession,assistant]]) {
            await connection.query('INSERT INTO session (id_session,id_login,`last`,active,created_at,created_by) VALUES (?,?,1,1,NOW(),?)',[idSession,idLogin,idLogin]);
        }
        for (const code of ['px.all', 'clinical_history.view', 'treatments.view', 'px.tab.monitoring', 'prescriptions.view.all', 'prescriptions.create']) {
            const [permissions] = await connection.query('SELECT id_cat_permission FROM cat_permission WHERE code=? AND active=1', [code]);
            assert.equal(permissions.length, 1, `Permission installed: ${code}`);
            await connection.query('INSERT INTO business_role_permission (id_business,id_rol,id_cat_permission,active) VALUES (?,?,?,1)', [business, assistantRole, permissions[0].id_cat_permission]);
        }
        for (const code of ['px.all', 'clinical_history.intake', 'px.tab.monitoring', 'tracing.create']) {
            const [permissions] = await connection.query('SELECT id_cat_permission FROM cat_permission WHERE code=? AND active=1', [code]);
            assert.equal(permissions.length, 1, `Permission installed: ${code}`);
            await connection.query('INSERT INTO business_role_permission (id_business,id_rol,id_cat_permission,active) VALUES (?,?,?,1)', [business, receptionRole, permissions[0].id_cat_permission]);
        }
        await connection.query('INSERT INTO person (id_person,id_business,name,surname,age,birthday,active,created_by) VALUES (?,?,?,?,?, ?,1,?)', [patient,business,'QA S19','INTEGRAL ROLLBACK',30,'1996-01-01',reception]);
        const intake = require('../../src/Dao/mysql/clinicalIntake.dao');
        const history = require('../../src/Dao/mysql/clinicalHistory.dao');
        const allergy = require('../../src/Dao/mysql/patientAllergy.dao');
        const tracing = require('../../src/Dao/mysql/tracing.Dao');
        const agenda = require('../../src/Dao/mysql/appointment.Dao');
        const rx = require('../../src/Dao/mysql/prescription.dao');
        const Plan = require('../../src/Dao/mysql/treatmentPlan.dao'), plans = new Plan();
        const home = require('../../src/Dao/mysql/homeContinuity.dao');
        const effective = require('../../src/util/effectivePermissions');
        const recipient = { clinicalHistoryView: true, pxAll: true, scope: { mode: 'own', idLogin: doctor.id_login, doctorProfileId: doctor.id_doctor_professional_profile } };
        const draftCount = async () => Number((await home.countClinicalDrafts(business, recipient))[0].total);
        const before = await draftCount();
        const receptionCtx = { id_business: business, id_login: reception, patient_id: patient };
        const initial = ok(await intake.get(receptionCtx), 'Initial intake');
        assert.equal(initial.suggested_doctor_profile_id, doctor.id_doctor_professional_profile);
        assert.equal(initial.doctors.length, 1);
        assert.deepEqual(Object.keys(initial.doctors[0]).sort(), ['id_doctor_professional_profile','professional_name']);
        const handoff = ok(await intake.save({ ...receptionCtx, doctor_responsible_profile_id: doctor.id_doctor_professional_profile, consultation: { reason: 'Revision de rutina QA', current_condition: 'Captura inicial dummy' } }), 'Intake handoff');
        const historyId = handoff.history.id_clinical_history;
        assert.equal(await draftCount(), before + 1);
        assert.equal((await history.getById({ ...receptionCtx, id_clinical_history: historyId })).status, 403);
        assert.equal((await history.finalize({ ...receptionCtx, id_clinical_history: historyId, expected_revision: 0 })).status, 403);
        const docCtx = { ...ctx, id_clinical_history: historyId };
        let chart = ok(await history.getById(docCtx), 'Doctor receives intake').history;
        assert.equal(chart.created_by_user_id, reception);
        assert.equal(chart.doctor_responsible_user_id, doctor.id_login);
        assert.equal(chart.clinical_snapshot_json.consultation.reason, 'Revision de rutina QA');
        ok(await allergy.update({ ...ctx, patient_id: patient, expected_revision: 0, review_status: 'NONE_KNOWN', description: '' }), 'Allergies review');
        assert.equal((await history.updateDraft({ ...docCtx, expected_revision: chart.revision, clinical_snapshot_json: chart.clinical_snapshot_json })).status, 409, 'Allergy review invalidates stale history draft');
        chart = ok(await history.getById(docCtx), 'Reload allergy-synchronized history').history;
        assert.equal(chart.clinical_snapshot_json.allergies_medications.allergy_status, 'NONE_KNOWN');
        const snapshot = structuredClone(chart.clinical_snapshot_json);
        for (const section of chart.template_snapshot_json.sections.filter(section => section.enabled !== false)) {
            snapshot[section.key] ||= {};
            for (const field of (section.fields || []).filter(field => field.enabled !== false && field.required && !(field.type === 'readonly' && field.source))) {
                if (section.key === 'allergies_medications') continue;
                snapshot[section.key][field.key] = ['boolean', 'checkbox'].includes(field.type) ? true
                    : field.type === 'multiselect' ? ['QA synthetic'] : field.type === 'number' ? 1 : 'QA synthetic - not clinical advice';
            }
        }
        chart = ok(await history.updateDraft({ ...docCtx, expected_revision: chart.revision, doctor_responsible_user_id: doctor.id_login, clinical_snapshot_json: snapshot }), 'Doctor completes required fields').history;
        assert.equal((await history.finalize({ ...docCtx, expected_revision: chart.revision })).status, 400, 'Consent required');
        const consent = await require('./helpers/s19-signed-consent').createSignedConsent({connection,business,patient,doctor});
        const finalized = ok(await history.finalize({ ...docCtx, expected_revision: chart.revision }), 'Finalize history').history;
        assert.equal(finalized.status, 'FINALIZED'); assert.equal(finalized.consent_document_id, consent);
        assert.equal(finalized.finalized_by_user_id, doctor.id_login); assert.equal(await draftCount(), before);
        assert.equal((await history.updateDraft({ ...docCtx, expected_revision: finalized.revision, clinical_snapshot_json: snapshot })).status, 409);
        const frozen = JSON.stringify(finalized.clinical_snapshot_json.allergies_medications);
        ok(await allergy.update({ ...ctx, patient_id: patient, expected_revision: 1, review_status: 'UNKNOWN', description: 'QA changed after snapshot' }), 'New current allergy state');
        assert.equal(JSON.stringify(ok(await history.getById(docCtx), 'Frozen chart reread').history.clinical_snapshot_json.allergies_medications), frozen, 'Finalized allergy snapshot remains immutable');
        checks.push('intake least privilege, one doctor suggestion, author/responsible separation, actual Home count, allergy revision conflict, required fields/consent created and signed through real DAOs, finalized immutable snapshot');

        const prescription = { create_request_id: uuid(), id_person: patient, issuer_doctor_id: doctor.id_login, issue_date: '2026-10-14', notes: 'QA S19 only', items: [{ generic_name: 'Medicamento ficticio QA', dose: 'Dosis ficticia', administration_route: 'Via ficticia', frequency: 'Frecuencia ficticia', duration: 'Duracion ficticia', indications: 'No usar para atencion' }] };
        const draft = ok(await rx.save({ ...ctx, prescription }), 'Create prescription draft');
        assert.equal(draft.id_prescription, prescription.create_request_id);
        assert.equal(ok(await rx.save({ ...ctx, prescription }), 'Replay prescription creation').id_prescription, draft.id_prescription);
        assert.equal((await rx.save({ ...ctx, prescription: { ...prescription, notes: 'Different retry' } })).status,409);
        assert.equal((await rx.save({ ...ctx, id_login: assistant, prescription })).status,409,'Another allowed creator cannot claim the replay');
        assert.notEqual((await rx.save({ ...ctx, id_business:'QA_BUSINESS_CLINICAL', prescription })).status,200,'Foreign tenant cannot claim the replay');
        assert.equal((await rx.save({ ...ctx, prescription: { ...prescription, create_request_id:'invalid-id' } })).status,400);
        const [createdRecipes] = await connection.query('SELECT COUNT(*) n FROM prescription WHERE id_person=?',[patient]); assert.equal(Number(createdRecipes[0].n),1);
        const [createdAudits] = await connection.query("SELECT COUNT(*) n FROM prescription_audit_log WHERE id_prescription=? AND action='created'",[draft.id_prescription]); assert.equal(Number(createdAudits[0].n),1);
        const rxCtx = { ...ctx, id_prescription: draft.id_prescription };
        for (const action of ['printed','downloaded','pdf_generated']) assert.equal((await rx.prepareOutput({ ...rxCtx, action })).status, 400);
        assert.notEqual((await rx.issue({ ...rxCtx, id_login: reception })).status, 200);
        assert.equal(ok(await rx.issue(rxCtx), 'Issue prescription').status, 'issued');
        assert.equal(ok(await rx.save({ ...ctx, prescription }), 'Replay creation after issue').status,'issued');
        for (const action of ['printed','downloaded','pdf_generated']) assert.equal(ok(await rx.prepareOutput({ ...rxCtx, action }), `Issued ${action}`).prescription.status, 'issued');
        assert.equal((await rx.save({ ...ctx, prescription: { ...prescription, id_prescription: draft.id_prescription } })).status, 400);
        assert.equal(ok(await rx.cancel({ ...rxCtx, reason: 'QA lifecycle finished' }), 'Cancel prescription').status, 'cancelled');
        assert.equal((await rx.save({ ...ctx, prescription })).status,409,'Cancelled recipe must not become a fresh draft via replay');
        for (const action of ['printed','downloaded','pdf_generated']) assert.equal((await rx.prepareOutput({ ...rxCtx, action })).status, 400);
        checks.push('prescription actual create/issue/cancel lifecycle and output authorization, no physical PDF or print');

        const planId = uuid(), itemId = uuid();
        let plan = ok(await plans.createPlan({ ...px, request_id: planId, title: 'QA S19 plan', started_at: '2026-10-14' }), 'Create plan').activePlan;
        assert.equal(plan.id_treatment_plan, planId);
        plan = ok(await plans.savePlanTreatment({ ...px, id_treatment_plan: planId, request_id: itemId, name: 'Procedimiento dummy S19', description: 'No clinical use', teeth: [] }), 'Add procedure').activePlan;
        assert.equal(plan.treatments[0].status, 'pending');
        plan = ok(await plans.updatePlanTreatmentStatus({ ...px, id_treatment_plan: planId, id_patient_treatment: itemId, status: 'in_progress' }), 'Start procedure').activePlan;
        assert.equal(plan.treatments[0].status, 'in_progress');
        const free = { id_tracing: uuid(), quote_date_now: '14-10-2026', treatment_now: 'Revision de rutina', quote_date_after: '', treatment_after: 'Sin retorno previsto', note: 'QA S19 free text no reservation' };
        const receptionTrace = { id_business: business, id_login: reception, id_person: patient };
        assert.equal(await effective.hasPermission(reception, 'px.dates'), false);
        ok(await tracing.saveTracing({ ...receptionTrace, tracing: [free] }), 'Follow-up actor without agenda');
        ok(await tracing.saveTracing({ ...receptionTrace, tracing: [free] }), 'Replay follow-up');
        assert.equal((await tracing.saveTracing({ ...receptionTrace, tracing: [{ ...free, note: 'Different replay' }] })).status, 409);
        let [rows] = await connection.query('SELECT COUNT(*) n FROM tracing WHERE id_person=?', [patient]); assert.equal(Number(rows[0].n),1);
        [rows] = await connection.query('SELECT COUNT(*) n FROM appointment WHERE id_person=?', [patient]); assert.equal(Number(rows[0].n),0);
        const linked = { ...free, id_tracing: uuid(), id_patient_treatment: itemId, treatment_now: 'Untrusted label', treatment_after: 'Revision del procedimiento' };
        const link = ok(await tracing.saveTracing({ ...px, tracing: [linked] }), 'Linked follow-up')[0];
        assert.equal(link.id_treatment_plan, planId); assert.equal(link.treatment_now, 'Procedimiento dummy S19');
        failTraceAudit = true;
        assert.equal((await tracing.UpdateTracing({ ...px, tracing: [{ ...linked, treatment_now: link.treatment_now, revision: 1, change_reason: 'QA rollback injection', note: 'Must not save' }] })).status, 500);
        failTraceAudit = false;
        assert.equal((await tracing.record(px, link.id_tracing)).revision, 1);
        checks.push('free procedure/without return and without agenda permission, create UUID replay, changed replay rejection, real treatment linkage, audit failure rollback');

        const agendaConfig = ok(await agenda.getConfig({ ...ctx, doctor_profile_id: doctor.id_doctor_professional_profile }), 'Read actual doctor schedule');
        assert.ok(Boolean(agendaConfig.enabled), 'Professional QA doctor agenda is enabled');
        assert.equal(agendaConfig.businessEnabled, true);
        const day = agendaConfig.workingDays.find(day => day.enabled && day.timeRanges.length);
        assert.ok(day, 'QA schedule must contain working range');
        const date = new Date('2035-01-01T12:00:00Z');
        while (date.getUTCDay() !== Number(day.dayOfWeek)) date.setUTCDate(date.getUTCDate()+1);
        const startTime = day.timeRanges[0].startTime.slice(0,5);
        const minutes = Number(startTime.slice(0,2))*60+Number(startTime.slice(3))+30;
        const endTime = `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
        const appointment = { patientId: patient, followUpId: link.id_tracing, doctorProfileId: doctor.id_doctor_professional_profile, date: date.toISOString().slice(0,10), startTime, endTime, status: 'pending_confirmation', title: 'QA S19 seguimiento', source: 'follow_up' };
        const request = { ...ctx, appointment, sync_follow_up: true };
        const reserved = ok(await agenda.save(request), 'Reserve follow-up')[0];
        assert.equal(ok(await agenda.save(request), 'Replay reservation')[0].id, reserved.id);
        assert.equal((await agenda.save({ ...request, appointment: { ...appointment, title: 'Different replay' } })).status, 409);
        assert.notEqual((await agenda.save({ ...ctx, appointment: { ...appointment, followUpId: null } })).status, 200, 'Occupied doctor slot refuses duplicate');
        [rows] = await connection.query('SELECT COUNT(*) n FROM appointment WHERE id_person=?', [patient]); assert.equal(Number(rows[0].n),1);
        [rows] = await connection.query('SELECT COUNT(*) n FROM tracing WHERE id_person=?', [patient]); assert.equal(Number(rows[0].n),2);
        const failedBooking = { ...request, appointment: { ...appointment, followUpId: free.id_tracing } };
        assert.notEqual((await agenda.save(failedBooking)).status,200,'Saved follow-up survives an occupied-slot failure');
        const laterEndMinutes = minutes + 30;
        const retry = { ...failedBooking, appointment: { ...failedBooking.appointment, startTime:endTime,
            endTime:`${String(Math.floor(laterEndMinutes/60)).padStart(2,'0')}:${String(laterEndMinutes%60).padStart(2,'0')}` } };
        const recovered = ok(await agenda.save(retry),'Retry only booking at another available time')[0];
        assert.equal(ok(await agenda.save(retry),'Replay recovered booking')[0].id,recovered.id);
        [rows] = await connection.query('SELECT COUNT(*) n FROM tracing WHERE id_person=?',[patient]); assert.equal(Number(rows[0].n),2,'Booking recovery creates no extra follow-up');
        [rows] = await connection.query('SELECT COUNT(*) n FROM appointment WHERE id_person=?',[patient]); assert.equal(Number(rows[0].n),2,'Booking recovery creates exactly one extra reservation');
        await connection.query("UPDATE appointment SET status='completed' WHERE id_appointment=? AND id_person=?", [reserved.id,patient]);
        assert.equal((await agenda.save({ ...request, appointment: { ...appointment, id: reserved.id } })).status, 409, 'Correction cannot reopen completed appointment');
        const ownHistory = ok(await agenda.patientHistory({ ...px, follow_up_id: link.id_tracing }), 'Exact follow-up history');
        assert.equal(ownHistory.appointments.length,1); assert.equal(ownHistory.appointments[0].id,reserved.id);
        const upcoming = ok(await agenda.patientHistory({ ...px, upcoming_from: '2026-10-14', upcoming_time: '00:00' }), 'Future active history');
        assert.equal(upcoming.appointments.length,1); assert.equal(upcoming.appointments[0].id,recovered.id,'Only the pending future booking is upcoming');
        checks.push('actual agenda stored procedures/doctor schedule, lost-response replay, changed replay and occupied slot rejection, changed-time booking recovery without duplicate follow-up, terminal booking not reopened, exact and future filters');

        plan = ok(await plans.updatePlanTreatmentStatus({ ...px, id_treatment_plan: planId, id_patient_treatment: itemId, status: 'completed' }), 'Complete treatment').activePlan;
        assert.equal(plan.treatments[0].status,'completed');
        const closed = ok(await plans.closePlan({ ...px, id_treatment_plan: planId, close_reason:'QA lifecycle complete' }), 'Close plan');
        assert.equal(closed.activePlan,null); assert.equal(closed.history[0].status,'closed');
        assert.equal((await plans.updatePlanTreatmentStatus({ ...px, id_treatment_plan: planId, id_patient_treatment: itemId, status:'in_progress' })).status,400);
        ok(await tracing.saveTracing({ ...px, tracing: [linked] }), 'Replay linked follow-up after close');
        assert.equal((await tracing.saveTracing({ ...px, tracing: [{...linked,id_tracing:uuid()}] })).status,400,'New linkage to closed plan refused');
        assert.equal((await tracing.GetTracing({...px,id_business:'QA_BUSINESS_CLINICAL'})).status,403);
        assert.equal((await plans.getPlan({...px,id_business:'QA_BUSINESS_CLINICAL'})).status,403);
        checks.push('treatment pending/in progress/completed/closed historical lifecycle, immutable closed plan, old follow-up replay and tenant isolation');
        checks.push(await require('./helpers/s19-http-surface')({ business, patient,
            doctor: { id_login: doctor.id_login, id_session:doctorSession, rol: 'doctor' }, reception: { id_login: reception, id_session:receptionSession, rol: `qa_s19_${receptionRole}` },
            assistant: { id_login: assistant, id_session:assistantSession, rol: assistantRoleCode }, historyId, prescriptionId: draft.id_prescription, planId }));
        await connection.rollback();
        const [counterAfter] = await connection.query('SELECT folio_year,current_value,updated_at FROM prescription_folio_counter WHERE id_business=? ORDER BY folio_year',[business]);
        assert.deepEqual(counterAfter,counterBefore,'Prescription folio counter remains unchanged');
        for (const session of [doctorSession,receptionSession,assistantSession]) {
            const [remaining] = await connection.query('SELECT COUNT(*) n FROM session WHERE id_session=?',[session]); assert.equal(Number(remaining[0].n),0,'Session fixture absent after rollback');
        }
        for (const [table,column,id] of [['person','id_person',patient],['login','id_login',reception],['rol','id_rol',receptionRole],['login','id_login',assistant],['rol','id_rol',assistantRole],['clinical_histories','patient_id',patient],['prescription','id_person',patient],['treatment_plan','id_person',patient],['tracing','id_person',patient],['appointment','id_person',patient]]) {
            const [remaining] = await connection.query(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`,[id]); assert.equal(Number(remaining[0].n),0,`${table}: rollback absent`);
        }
        console.log('PASS S19 Professional SQL integral: '+checks.join('; ')+'. One connection; every dummy row rolled back and absence verified. No email, clinical output, permissions of existing roles, schema or production data changes.');
    } finally { await connection.rollback(); await connection.end(); }
})().catch(error => { console.error('S19 integral SQL:',error.code || error.message, error.code === 'ERR_ASSERTION' ? error.stack : ''); process.exitCode=1; });

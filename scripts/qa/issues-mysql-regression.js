'use strict';
// Explicit loopback instance only. Never reads the configured application DB.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const { Sequelize, QueryTypes } = require('sequelize');
const { migrate } = require('../migrations/patient-code-counter');
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };

(async () => {
    assert.equal(process.env.ISSUES_QA_ISOLATED, '1', 'Explicit opt-in required');
    const port = Number(process.env.ISSUES_QA_PORT);
    assert.ok(Number.isInteger(port) && port > 1024 && port !== 3306);
    const name = 'qa_issues_' + randomUUID().replaceAll('-', '');
    const connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' });
    let db;
    try {
        await connection.query('CREATE DATABASE ' + mysql.escapeId(name) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await connection.changeUser({ database: name });
        const tables = ['business', 'rol', 'login', 'doctor_professional_profile', 'business_license_overrides',
            'cat_permission', 'permission_rol', 'business_role_permission', 'admin_audit_log',
            'person', 'address', 'query', 'allergy', 'prescription', 'prescription_item', 'prescription_config', 'prescription_audit_log',
            'tracing', 'appointment', 'appointment_config', 'appointment_working_day', 'appointment_time_range', 'appointment_blocked_date', 'appointment_blocked_hour'];
        for (const table of tables) {
            const file = await fs.readFile(path.resolve(__dirname, '../../../u575589445_orrico/Tables', table + '.sql'), 'utf8');
            const ddl = file.match(/CREATE TABLE[\s\S]*?;\s*$/)[0];
            assert.doesNotMatch(ddl, /DROP\s+TABLE/i);
            await connection.query(ddl);
        }
        const [configColumns] = await connection.query('SHOW COLUMNS FROM prescription_config');
        if (!configColumns.some(c => c.Field === 'doctor_profile_id')) await connection.query('ALTER TABLE prescription_config ADD doctor_profile_id VARCHAR(50) NULL');
        await connection.query("INSERT INTO person(id_person,code) VALUES('old-a','000001'),('old-b','000001')");
        await assert.rejects(migrate(connection, true), /DUPLICATES/);
        await connection.query("DELETE FROM person WHERE id_person='old-b'");
        await migrate(connection, true);
        await migrate(connection, true); // Safe repeat preserves an existing counter.
        db = new Sequelize(name, 'root', '', { host: '127.0.0.1', port, dialect: 'mysql', logging: false, pool: { max: 3, min: 0, idle: 1000 } });
        stub('../../src/config/env', {});
        stub('../../src/config/config', { BUCKETS: {} });
        stub('../../src/services/aws/s3', {});
        stub('../../src/db/Sequelize.connection', db);
        const users = require('../../src/Dao/mysql/user.dao');
        const patients = require('../../src/Dao/mysql/px.dao');
        const prescriptions = require('../../src/Dao/mysql/prescription.dao');
        // Permission middleware has separate HTTP coverage. Domain and SQL are real.
        users.hasPermission = prescriptions.hasPermission = async () => true;
        await connection.query("INSERT INTO business(id_business,name,slug,plan) VALUES('tenant','QA','qa','basic')");
        await connection.query("INSERT INTO rol(id_rol,code,active) VALUES('doctor-role','doctor',1),('staff-role','assistant',1),('platform-role','super_admin',1)");
        const user = suffix => ({ id_business: 'tenant', id_login: 'qa-actor', id_rol: 'doctor-role', name: 'Synthetic ' + suffix,
            email: suffix + '@example.invalid', phone: suffix, password: 'Synthetic-only-password-2026' });
        assert.equal((await users.saveUser({ ...user('reserved'), id_rol: 'platform-role' })).status, 403);
        const created = await Promise.all([users.saveUser(user('one')), users.saveUser(user('two'))]);
        assert.deepEqual(created.map(r => r.status).sort(), [200, 409], JSON.stringify(created));
        const doctorId = created.find(r => r.status === 200).data.id_login;
        assert.equal((await users.updateUser({ ...user('reserved-change'), id_rol: 'platform-role' }, doctorId)).status, 403);
        await connection.query("INSERT INTO login(id_login,id_rol,id_business,name,active) VALUES('inactive','doctor-role','tenant','QA inactive',0)");
        await connection.query('UPDATE login SET active=0 WHERE id_login=?', [doctorId]);
        const activated = await Promise.all([doctorId, 'inactive'].map(id => users.updateUser({ id_business: 'tenant', id_login: 'qa-actor', active: true }, id)));
        assert.deepEqual(activated.map(r => r.status).sort(), [200, 409], JSON.stringify(activated));
        await connection.query("UPDATE login SET active=0 WHERE id_business='tenant'");
        await connection.query("INSERT INTO login(id_login,id_rol,id_business,name,active) VALUES('staff-a','staff-role','tenant','QA a',1),('staff-b','staff-role','tenant','QA b',1)");
        const profiles = await Promise.all(['staff-a', 'staff-b'].map(id => users.saveProfessionalProfile({ id_business: 'tenant', id_login: id,
            professional_name: 'QA', professional_license: 'TEST', signature_image: 'synthetic', can_issue_prescriptions: true })));
        assert.deepEqual(profiles.map(r => r.status).sort(), [200, 409], JSON.stringify(profiles));
        console.log('PASS MySQL quota: concurrent create, activation, profile activation; platform role denied.');

        const patient = suffix => ({ id_business: 'tenant', id_login: 'qa-actor', person: { name: 'Patient', surname: suffix,
            birthday: '2000-01-02', age: 26, telephone: '5550000000' }, address: {} });
        const newPatients = await Promise.all([patients.pxCreateMinimal(patient('A')), patients.pxCreateMinimal(patient('B'))]);
        assert.ok(newPatients.every(r => r.status === 200), JSON.stringify(newPatients));
        const [codes] = await connection.query("SELECT code FROM person WHERE id_business='tenant'");
        assert.equal(new Set(codes.map(row => row.code)).size, 2);
        await assert.rejects(connection.query("INSERT INTO person(id_person,code) VALUES('collision',?)", [codes[0].code]), e => e.code === 'ER_DUP_ENTRY');
        const tx = await db.transaction();
        const { nextPatientCode } = require('../../src/util/patientCode');
        const rolledBack = await nextPatientCode(db, tx);
        await tx.rollback();
        const afterRollback = await patients.pxCreateMinimal(patient('C'));
        assert.equal(afterRollback.status, 200);
        const [[committed]] = await connection.query('SELECT code FROM person WHERE id_person=?', [afterRollback.data.id_person]);
        assert.equal(committed.code, rolledBack, 'Only an uncommitted reservation may be reused');
        console.log('PASS MySQL patient codes: concurrent creates, unique constraint, duplicate preflight, rollback.');

        await connection.query("UPDATE login SET active=0 WHERE id_business='tenant'");
        await connection.query('UPDATE login SET active=1 WHERE id_login=?', [doctorId]);
        await connection.query("INSERT INTO doctor_professional_profile(id_doctor_professional_profile,id_business,id_login,professional_name,professional_license,signature_image) VALUES('rx-doctor','tenant',?,'QA doctor','QA license','synthetic')", [doctorId]);
        await connection.query("INSERT INTO prescription_config(id_prescription_config,id_business,doctor_profile_id,clinic_name,clinic_address,clinic_phone,active) VALUES('rx-config','tenant','rx-doctor','QA','QA address','5550000000',1)");
        const patientId = newPatients[0].data.id_person;
        await connection.query("INSERT INTO prescription(id_prescription,id_business,id_person,folio,status,issuer_doctor_id,created_by,issue_date) VALUES('rx','tenant',?,'QA-1','draft',?,?,CURRENT_DATE)", [patientId, doctorId, doctorId]);
        await connection.query("INSERT INTO prescription_item(id_prescription_item,id_prescription,id_business,generic_name,dose,administration_route,frequency,duration) VALUES('rx-item','rx','tenant','QA','QA','QA','QA','QA')");
        const body = { id_business: 'tenant', id_login: doctorId, id_prescription: 'rx', action: 'pdf_generated' };
        assert.equal((await prescriptions.getPrescription('rx','tenant')).patient_identity_source, 'current_record');
        const issued = await prescriptions.issue(body);
        assert.equal(issued.status, 200, JSON.stringify(issued));
        const before = await prescriptions.prepareOutput(body);
        assert.equal(before.status, 200);
        await connection.query("UPDATE person SET name='Edited',birthday='1990-03-04',age=36 WHERE id_person=?", [patientId]);
        const after = await prescriptions.prepareOutput(body);
        for (const key of ['patient_name','patient_age','patient_birthday']) assert.equal(after.data.prescription[key], before.data.prescription[key]);
        assert.equal(after.data.prescription.patient_identity_source, 'issued_snapshot');
        assert.equal((await prescriptions.issue(body)).status, 200, 'Retry keeps the snapshot');
        const listed = await prescriptions.list({ id_business: 'tenant', id_login: doctorId });
        assert.equal(listed.status, 200, JSON.stringify(listed));
        assert.equal(listed.data[0].patient_name, before.data.prescription.patient_name);
        await connection.query("UPDATE prescription SET template_snapshot=NULL WHERE id_prescription='rx'");
        assert.equal((await prescriptions.getPrescription('rx','tenant')).patient_identity_source, 'legacy_current_record');
        console.log('PASS MySQL prescription: issue, patient edit, repeat output/list/retry, explicit legacy fallback.');

        const agendaMigration = (await fs.readFile(path.resolve(__dirname, '../../Scripts_/20261021_agenda_co21_up.sql'), 'utf8')).replace(/^--.*$/gm, '');
        for (const sql of agendaMigration.split(';').map(s => s.trim()).filter(Boolean)) await connection.query(sql);
        await connection.query(await fs.readFile(path.resolve(__dirname, '../migrations/sql/SP_appointment_config_get.sql'), 'utf8'));
        await connection.query("INSERT INTO person(id_person,id_business,code,name,active) VALUES('QAC_PATIENT_01','tenant','QA_CO11','QA appointment',1)");
        await connection.query("INSERT INTO appointment_config(id_appointment_config,id_business,doctor_profile_id,enabled) VALUES('agenda-general','tenant',NULL,1),('agenda-doctor','tenant','rx-doctor',1)");
        await connection.query("INSERT INTO appointment_working_day(id_appointment_working_day,id_business,id_appointment_config,day_of_week,enabled) VALUES('monday','tenant','agenda-doctor',1,1)");
        await connection.query("INSERT INTO appointment_time_range(id_appointment_time_range,id_business,id_appointment_working_day,start_time,end_time) VALUES('morning','tenant','monday','08:00','18:00')");
        const agenda = spawnSync(process.execPath, [path.resolve(__dirname, 'co11-appointment-concurrency.js')], {
            cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30000,
            env: { ...process.env, QA_APPOINTMENT_ISOLATED: '1', DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: name, SQL_LOGGING: 'false' }
        });
        assert.equal(agenda.status, 0, agenda.stdout + agenda.stderr);
        for (const table of ['appointment','appointment_write_request','appointment_audit']) {
            const [[row]] = await connection.query('SELECT COUNT(*) n FROM ' + table);
            assert.equal(Number(row.n), 0, 'CO11 cleans its appointment, receipts and audit');
        }
        console.log('PASS MySQL CO11: distinct request ids, slot conflict, idempotent retry and complete fixture cleanup.');

        await connection.query('CREATE TABLE registration_rate_bucket(bucket_key VARCHAR(64) PRIMARY KEY, hits INT NOT NULL, expires_at DATETIME(3) NOT NULL, KEY expiry(expires_at)) ENGINE=InnoDB');
        await connection.query("INSERT INTO registration_rate_bucket VALUES ('active',1,DATE_ADD(NOW(3),INTERVAL 1 DAY)),('expired',1,DATE_SUB(NOW(3),INTERVAL 1 DAY))");
        const { RegistrationRateLimit } = require('../../src/services/registration/registrationRateLimit');
        await new RegistrationRateLimit(db).consume([]);
        const [retained] = await connection.query('SELECT bucket_key FROM registration_rate_bucket');
        assert.deepEqual(retained.map(row => row.bucket_key), ['active']);
        const readiness = require('../../src/services/readiness').createReadiness(db);
        await readiness.initialize(); assert.equal(await readiness.check(), true);
        console.log('PASS MySQL expired-bucket cleanup preserves active quota; readiness validates schema and queries the existing pool.');
    } finally {
        if (db) await db.close();
        await connection.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(name));
        await connection.end();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

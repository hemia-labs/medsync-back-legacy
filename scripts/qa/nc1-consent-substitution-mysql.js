// Isolated real MySQL only. Never loads .env or a shared database configuration.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');
const name = 'medsync-nc1-b-' + Date.now();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ids = Object.fromEntries(['patient', 'refusal', 'signed', 'doctor', 'assistant', 'other', 'profile', 'business', 'role', 'view', 'sign'].map(key => [key, randomUUID()]));
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };

(async () => {
    let db, sequelize, started = false;
    try {
        docker('run', '--detach', '--rm', '--name', name, '--memory', '768m', '--cpus', '1', '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
            '-e', 'MYSQL_ROOT_HOST=%', '-e', 'MYSQL_DATABASE=qa_nc1_b', '-p', '127.0.0.1::3306', 'mysql:8.0'); started = true;
        const port = Number(docker('port', name, '3306/tcp').split(':').at(-1));
        const config = { host: '127.0.0.1', port, user: 'root', password: '', database: 'qa_nc1_b' };
        for (let i = 0; i < 90; i++) { try { db = await mysql.createConnection(config); break; } catch (_) { await pause(500); } }
        assert.ok(db, 'ISOLATED_MYSQL_NOT_READY');
        const tables = {
            person: 'id_person varchar(36) PRIMARY KEY, id_business varchar(36), active tinyint',
            login: 'id_login varchar(36) PRIMARY KEY, id_business varchar(36), id_rol varchar(36), active tinyint',
            rol: 'id_rol varchar(36) PRIMARY KEY, code varchar(80), active tinyint',
            cat_permission: 'id_cat_permission varchar(36) PRIMARY KEY, code varchar(80), active tinyint, is_active tinyint',
            permission_rol: 'id_rol varchar(36), id_cat_permission varchar(36), active tinyint',
            business_role_permission: 'id_business varchar(36), id_rol varchar(36), id_cat_permission varchar(36), active tinyint',
            doctor_professional_profile: 'id_doctor_professional_profile varchar(36) PRIMARY KEY, id_login varchar(36), id_business varchar(36), professional_name varchar(150), professional_license varchar(80), is_active tinyint, can_sign_documents tinyint',
            patient_documents: 'id_patient_document varchar(36) PRIMARY KEY, id_business varchar(36), id_person varchar(36), document_type varchar(80), title varchar(180), active tinyint, status varchar(50), signed_at datetime, created_at datetime, refusal_reason varchar(500), responsible_doctor_user_id varchar(36), responsible_doctor_profile_id varchar(36), doctor_name_snapshot varchar(150)',
            patient_document_events: 'id_patient_document_event varchar(36) PRIMARY KEY, id_patient_document varchar(36), id_business varchar(36), event_type varchar(80), notes varchar(1000), created_at datetime, created_by varchar(36)',
            clinical_histories: 'id_clinical_history varchar(36) PRIMARY KEY, business_id varchar(36), patient_id varchar(36), status varchar(50), revision int, deleted_at datetime NULL, consent_document_id varchar(36), clinical_snapshot_json longtext, template_snapshot_json longtext, responsible_snapshot_json longtext, finalizer_snapshot_json longtext, doctor_responsible_user_id varchar(36), doctor_responsible_profile_id varchar(36), updated_by_user_id varchar(36), updated_at datetime, finalized_by_user_id varchar(36), finalized_at datetime',
            clinical_history_events: 'id_clinical_history_event varchar(36) PRIMARY KEY, clinical_history_id varchar(36), business_id varchar(36), patient_id varchar(36), event_type varchar(80), user_id varchar(36), metadata_json longtext, created_at datetime'
        };
        for (const [table, columns] of Object.entries(tables)) await db.query(`CREATE TABLE ${table} (${columns}) ENGINE=InnoDB COLLATE utf8mb4_unicode_ci`);
        sequelize = new Sequelize('qa_nc1_b', 'root', '', { host: '127.0.0.1', port, dialect: 'mysql', logging: false, pool: { max: 2, min: 0 } });
        stub('../../src/db/Sequelize.connection', sequelize);
        const service = require('../../src/services/documentSignature/sensitiveConsent.service');
        await db.query('INSERT INTO person VALUES (?,?,1)', [ids.patient, ids.business]);
        await db.query("INSERT INTO rol VALUES (?,'doctor',1)", [ids.role]);
        for (const actor of ['doctor', 'assistant', 'other']) await db.query('INSERT INTO login VALUES (?,?,?,1)', [ids[actor], ids.business, ids.role]);
        for (const perm of ['view', 'sign']) {
            await db.query('INSERT INTO cat_permission VALUES (?,?,1,1)', [ids[perm], 'documents.' + perm]);
            await db.query('INSERT INTO permission_rol VALUES (?,?,1)', [ids.role, ids[perm]]);
        }
        await db.query("INSERT INTO doctor_professional_profile VALUES (?,?,?,'Doctor QA','QA000',1,1)", [ids.profile, ids.doctor, ids.business]);
        for (const [key, status, signed] of [['refusal', 'NO_FIRMADO_POR_NEGATIVA', null], ['signed', 'FIRMADO', '2026-01-01 12:00:00']]) {
            await db.query("INSERT INTO patient_documents VALUES (?,?,?,'SENSITIVE_DATA_CONSENT','QA',1,?,?,'2026-01-01 10:00:00','Negativa QA',?,?,'Doctor QA')",
                [ids[key], ids.business, ids.patient, status, signed, ids.doctor, ids.profile]);
        }
        await db.query("INSERT INTO patient_document_events VALUES (?,?,?,'REFUSAL_REGISTERED','Negativa QA','2026-01-01 11:00:00',?)", [randomUUID(), ids.refusal, ids.business, ids.doctor]);
        await db.query("INSERT INTO clinical_histories (id_clinical_history,status,consent_document_id,clinical_snapshot_json) VALUES ('history-qa','INCOMPLETE',?,'{\"retained\":true}')", [ids.refusal]);
        const history = (await db.query('SELECT * FROM clinical_histories'))[0];
        const body = { id_person: ids.patient, id_business: ids.business, id_login: ids.doctor };
        const reviewed = async () => { const response = await service.review(body); assert.equal(response.status, 200); return response.data; };
        const request = async () => ({ ...body, refusal_id: ids.refusal, signed_id: ids.signed, request_id: randomUUID(),
            reason: 'Consentimiento posterior revisado en QA.', expected_consent_token: (await reviewed()).substitution_token });
        const count = async () => (await db.query("SELECT COUNT(*) n FROM patient_document_events WHERE event_type IN ('REFUSAL_SUPERSEDED','SUPERSEDES_REFUSAL')"))[0][0].n;

        const first = await request();
        for (const actor of ['assistant', 'other']) assert.equal((await service.substitute({ ...first, id_login: ids[actor] })).status, 403);
        await db.query("UPDATE rol SET code='assistant'");
        assert.equal((await service.substitute(first)).status, 403, 'Even a profile with sign flags cannot authorize as assistant');
        await db.query("UPDATE rol SET code='doctor'");
        await db.query('UPDATE doctor_professional_profile SET is_active=0');
        assert.equal((await service.substitute(first)).status, 403);
        await db.query('UPDATE doctor_professional_profile SET is_active=1');
        await db.query('UPDATE doctor_professional_profile SET can_sign_documents=0');
        assert.equal((await service.substitute(first)).status, 403);
        await db.query('UPDATE doctor_professional_profile SET can_sign_documents=1');
        await db.query('UPDATE login SET active=0 WHERE id_login=?', [ids.doctor]);
        assert.equal((await service.substitute(first)).status, 403);
        await db.query('UPDATE login SET active=1');
        await db.query('UPDATE permission_rol SET active=0 WHERE id_cat_permission=?', [ids.sign]);
        assert.equal((await service.substitute(first)).status, 403);
        await db.query('UPDATE permission_rol SET active=1');
        assert.equal(await count(), 0); console.log('PASS current permissions, profile and responsible actor; no writes on denial');

        await db.query("CREATE TRIGGER qa_fail_mirror BEFORE INSERT ON patient_document_events FOR EACH ROW BEGIN IF NEW.event_type='SUPERSEDES_REFUSAL' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic second insert failure'; END IF; END");
        await assert.rejects(service.substitute(first)); assert.equal(await count(), 0);
        await db.query('DROP TRIGGER qa_fail_mirror'); console.log('PASS atomic rollback when second mirror fails');

        const secondRequest = { ...first, request_id: randomUUID() };
        const concurrent = await Promise.all([service.substitute(first), service.substitute(secondRequest)]);
        const winner = concurrent[0].status === 200 ? first : secondRequest;
        assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]); assert.equal(await count(), 2);
        assert.equal((await reviewed()).consent_status, 'FIRMADO');
        assert.equal((await service.substitute(winner)).data.idempotent, true); assert.equal(await count(), 2);
        assert.equal((await service.substitute({ ...winner, reason: 'Otra intención de autorización QA.' })).status, 409);
        assert.deepEqual((await db.query('SELECT * FROM clinical_histories'))[0], history);
        assert.equal((await db.query('SELECT status FROM patient_documents WHERE id_patient_document=?', [ids.refusal]))[0][0].status, 'NO_FIRMADO_POR_NEGATIVA');
        console.log('PASS concurrent substitutions, scoped idempotency and immutable historical links');

        await db.query("UPDATE patient_documents SET status='CANCELADO' WHERE id_patient_document=?", [ids.signed]);
        assert.equal((await reviewed()).consent_status, 'NO_FIRMADO_POR_NEGATIVA');
        await db.query("UPDATE patient_documents SET status='FIRMADO', signed_at='2026-01-02 12:00:00' WHERE id_patient_document=?", [ids.signed]);
        const stale = await request();
        // The actual patient mutex is held by a competing writer. B must wait then see the new event.
        const writer = await sequelize.transaction();
        await service.lockPatient(ids.patient, ids.business, writer);
        let finished = false;
        const waiting = service.substitute(stale).then(value => { finished = true; return value; });
        await pause(150); assert.equal(finished, false, 'substitution bypassed the patient lock');
        await sequelize.query("INSERT INTO patient_document_events VALUES (:id,:document,:business,'REFUSAL_REGISTERED','Nueva negativa','2026-01-02 11:00:00',:actor)",
            { replacements: { id: randomUUID(), document: ids.refusal, business: ids.business, actor: ids.doctor }, transaction: writer });
        await writer.commit();
        assert.equal((await waiting).data.code, 'CONSENT_REVIEW_CHANGED');
        assert.equal((await reviewed()).consent_status, 'NO_FIRMADO_POR_NEGATIVA');
        const renewed = await request(); assert.equal((await service.substitute(renewed)).status, 200);
        assert.equal(await count(), 4); console.log('PASS patient lock, current read after waiting, renewed refusal and subsequent replacement');

        // Run the real finalize implementation, lockDraft, consent resolver, updates and events.
        // Non-consent identity/template presentation dependencies are supplied synthetic metadata.
        const histories = require('../../src/Dao/mysql/clinicalHistory.dao');
        const allergies = require('../../src/Dao/mysql/patientAllergy.dao');
        histories.hasPermission = async () => true;
        histories.getDoctorProfile = async () => ({ id_login: ids.doctor, id_doctor_professional_profile: ids.profile,
            professional_profile_active: 1, professional_name: 'Doctor QA', professional_license: 'QA000', rol: 'doctor' });
        histories.getPatient = async () => ({ id_person: ids.patient });
        histories.getHistoryById = async (id, business, transaction) => (await sequelize.query('SELECT * FROM clinical_histories WHERE id_clinical_history=:id AND business_id=:business',
            { replacements: { id, business }, transaction, type: require('sequelize').QueryTypes.SELECT }))[0];
        histories.getById = async (body, transaction) => ({ status: 200, data: { history: await histories.getHistoryById(body.id_clinical_history, body.id_business, transaction) } });
        histories.validateRequiredFieldsFromTemplate = () => ({ ok: true });
        allergies.getCurrent = async () => ({ review_status: 'NONE_KNOWN', revision: 1 });
        const draft = randomUUID();
        await db.query("INSERT INTO clinical_histories (id_clinical_history,business_id,patient_id,status,revision,clinical_snapshot_json,template_snapshot_json) VALUES (?,?,?,'DRAFT',1,'{}','{\"sections\":[]}')", [draft, ids.business, ids.patient]);
        const reviewedClose = await service.load(ids.patient, ids.business);
        const closer = { ...body, id_clinical_history: draft, expected_revision: 1, expected_consent_token: reviewedClose.token,
            expected_consent_document_id: ids.signed, expected_consent_status: 'FIRMADO' };
        const competing = await sequelize.transaction(); await service.lockPatient(ids.patient, ids.business, competing);
        let closeFinished = false;
        const close = histories.finalize(closer).then(result => { closeFinished = true; return result; });
        await pause(150); assert.equal(closeFinished, false);
        await sequelize.query("INSERT INTO patient_document_events VALUES (:id,:document,:business,'REFUSAL_REGISTERED','Nueva negativa antes del cierre','2026-01-03 11:00:00',:actor)",
            { replacements: { id: randomUUID(), document: ids.refusal, business: ids.business, actor: ids.doctor }, transaction: competing });
        await competing.commit();
        assert.equal((await close).data.code, 'CONSENT_REVIEW_CHANGED');
        const kept = (await db.query('SELECT * FROM clinical_histories WHERE id_clinical_history=?', [draft]))[0][0];
        assert.equal(kept.status, 'DRAFT'); assert.equal(kept.revision, 1); assert.equal(kept.responsible_snapshot_json, null);
        const currentClose = await service.load(ids.patient, ids.business);
        const incomplete = await histories.finalize({ ...closer, expected_consent_token: currentClose.token,
            expected_consent_document_id: ids.refusal, expected_consent_status: 'NO_FIRMADO_POR_NEGATIVA' });
        assert.equal(incomplete.status, 200); assert.equal(incomplete.data.history.status, 'INCOMPLETE');
        assert.equal(incomplete.data.history.consent_document_id, ids.refusal);
        assert.deepEqual((await db.query("SELECT * FROM clinical_histories WHERE id_clinical_history='history-qa'"))[0], history);
        console.log('PASS real finalize waits on patient, rejects new refusal before all writes, and explicit rereview closes INCOMPLETE');
        console.log('NC1_B_MYSQL_PASS');
    } finally {
        if (db) await db.end(); if (sequelize) await sequelize.close();
        if (started) docker('rm', '-f', name);
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

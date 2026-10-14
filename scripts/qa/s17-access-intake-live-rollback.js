// Real SQL, one connection; every fixture and temporary permission is rolled back.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { injectReplacements } = require('sequelize/lib/utils/sql');
const { v4: uuid } = require('uuid');
const config = require('../../src/config/config');
const dialect = { name: 'mysql', TICK_CHAR_LEFT: '`', TICK_CHAR_RIGHT: '`', canBackslashEscape: () => true, supports: {} };

(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    let serial = 0;
    const db = {
        async transaction() {
            const name = `s17_intake_${++serial}`;
            await connection.query(`SAVEPOINT ${name}`);
            return { commit: async () => connection.query(`RELEASE SAVEPOINT ${name}`),
                rollback: async () => { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); } };
        },
        async query(sql, options = {}) {
            assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|\bCALL\b/i);
            const [rows] = await connection.query(injectReplacements(sql, dialect, options.replacements));
            return rows;
        }
    };
    const dbId = require.resolve('../../src/db/Sequelize.connection');
    require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: db };
    const business = 'QA_BUSINESS_CLINICAL', actor = uuid(), role = uuid(), patient = uuid();
    try {
        await connection.beginTransaction();
        const [businesses] = await connection.query('SELECT id_business FROM business WHERE id_business=?', [business]);
        assert.equal(businesses.length, 1, 'QA tenant required');
        await connection.query('INSERT INTO rol (id_rol,code,desc_rol,active) VALUES (?,?,?,1)', [role, `qa_s17_${role}`, 'QA S17 rollback']);
        await connection.query('INSERT INTO login (id_login,id_business,id_rol,name,active) VALUES (?,?,?,?,1)', [actor, business, role, 'QA S17 rollback']);
        const setPermission = async (code, active, targetRole = role) => {
            const [exists] = await connection.query('SELECT id_cat_permission FROM cat_permission WHERE code=? AND active=1', [code]);
            assert.equal(exists.length, 1, `Permission must be installed: ${code}`);
            await connection.query(`INSERT INTO business_role_permission (id_business,id_rol,id_cat_permission,active) VALUES (?,?,?,?)
                ON DUPLICATE KEY UPDATE active=VALUES(active)`, [business, targetRole, exists[0].id_cat_permission, active]);
        };
        await setPermission('px.all', 1); await setPermission('px.dates', 1);
        await connection.query('INSERT INTO person (id_person,id_business,name,surname,active,created_by) VALUES (?,?,?,?,1,?)', [patient, business, 'QA S17', 'ROLLBACK', actor]);
        await connection.query("INSERT INTO allergy (id_allergy,id_business,id_patient,has_allergy,description,review_status,revision,created_by) VALUES (?,?,?,0,'','UNKNOWN',0,?)", [uuid(), business, patient, actor]);
        const intake = require('../../src/Dao/mysql/clinicalIntake.dao');
        const historyDao = require('../../src/Dao/mysql/clinicalHistory.dao');
        const { resolveDashboardAccess, seedDashboardPermissions } = require('../../src/util/dashboardAccess');
        const body = { id_business: business, id_login: actor, patient_id: patient };
        assert.equal((await intake.get(body)).status, 403);
        await setPermission('clinical_history.intake', 1);
        const first = await intake.get(body); assert.equal(first.status, 200, first.message); assert.equal(first.data.editable, true);
        const fields = first.data.fields;
        assert.ok(fields.includes('reason'), 'QA current template must enable consultation reason');
        assert.ok(first.data.doctors.length >= 2, 'QA clinic requires two available doctors');
        assert.deepEqual(Object.keys(first.data.doctors[0]).sort(), ['id_doctor_professional_profile', 'professional_name']);
        assert.equal(first.data.suggested_doctor_profile_id, null, 'Clinic selection is explicit');
        const [profiles] = await connection.query(`SELECT id_doctor_professional_profile,id_login FROM doctor_professional_profile
            WHERE id_business=? AND id_doctor_professional_profile IN (?,?) ORDER BY id_doctor_professional_profile`,
            [business, first.data.doctors[0].id_doctor_professional_profile, first.data.doctors[1].id_doctor_professional_profile]);
        assert.equal(profiles.length, 2);
        const home = require('../../src/Dao/mysql/homeContinuity.dao');
        const own = doctor => ({ clinicalHistoryView: true, pxAll: true, scope: { mode: 'own', idLogin: doctor.id_login, doctorProfileId: doctor.id_doctor_professional_profile } });
        const count = async doctor => Number((await home.countClinicalDrafts(business, own(doctor)))[0].total);
        const beforeA = await count(profiles[0]), beforeB = await count(profiles[1]);
        assert.equal((await intake.save({ ...body, consultation: { reason: 'No recipient' } })).status, 400);
        assert.equal((await intake.save({ ...body, consultation: { reason: 'Foreign recipient' }, doctor_responsible_profile_id: 'FOREIGN_PROFILE' })).status, 400);
        const created = await intake.save({ ...body, consultation: { reason: 'Paciente refiere molestia QA' }, doctor_responsible_profile_id: profiles[0].id_doctor_professional_profile });
        assert.equal(created.status, 200, created.message); assert.equal(created.data.history.revision, 0);
        const historyId = created.data.history.id_clinical_history;
        assert.equal(await count(profiles[0]), beforeA + 1, 'Recipient Home own gets the intake draft');
        assert.equal(await count(profiles[1]), beforeB, 'Another doctor Home own does not get the intake draft');
        const ownItems = await home.draftItems(business, profiles[0].id_login, own(profiles[0]));
        assert.ok(ownItems.some(item => item.patientId === patient), 'Fresh draft links to patient in recipient Home');
        assert.equal(ownItems.find(item => item.patientId === patient).path, `/px/history/${patient}?tab=history`, 'Handoff opens the clinical history instead of an unrelated default tab');
        const [identity] = await connection.query('SELECT created_by_user_id,doctor_responsible_user_id,doctor_responsible_profile_id,finalized_by_user_id FROM clinical_histories WHERE id_clinical_history=?', [historyId]);
        assert.equal(identity[0].created_by_user_id, actor); assert.equal(identity[0].doctor_responsible_user_id, profiles[0].id_login);
        assert.equal(identity[0].doctor_responsible_profile_id, profiles[0].id_doctor_professional_profile); assert.equal(identity[0].finalized_by_user_id, null);
        const [before] = await connection.query('SELECT clinical_snapshot_json FROM clinical_histories WHERE id_clinical_history=?', [historyId]);
        const baseline = JSON.parse(before[0].clinical_snapshot_json);
        baseline.diagnosis = { initial_diagnosis: 'PRIVATE QA DIAGNOSIS' };
        baseline.therapeutic_plan = { initial_plan: 'PRIVATE QA TREATMENT' };
        baseline.custom = { private: 'PRIVATE QA CUSTOM' };
        await connection.query('UPDATE clinical_histories SET clinical_snapshot_json=? WHERE id_clinical_history=?', [JSON.stringify(baseline), historyId]);
        const projected = await intake.get(body); assert.equal(projected.status, 200, projected.message);
        assert.ok(!JSON.stringify(projected.data).includes('PRIVATE QA'));
        const payload = { ...body, id_clinical_history: historyId, expected_revision: 0, consultation: { reason: 'Relato corregido QA' } };
        assert.equal((await intake.save({ ...payload, doctor_responsible_profile_id: profiles[1].id_doctor_professional_profile })).status, 403, 'Intake cannot reassign an existing responsible doctor');
        assert.equal((await intake.save({ ...payload, consultation: { diagnosis: 'Injection' } })).status, 400);
        assert.equal((await intake.save({ ...payload, clinical_snapshot_json: { diagnosis: 'Injection' } })).status, 400);
        const saved = await intake.save(payload); assert.equal(saved.status, 200, saved.message); assert.equal(saved.data.history.revision, 1);
        const [after] = await connection.query('SELECT clinical_snapshot_json FROM clinical_histories WHERE id_clinical_history=?', [historyId]);
        const snapshot = JSON.parse(after[0].clinical_snapshot_json);
        assert.equal(snapshot.consultation.reason, 'Relato corregido QA');
        for(const key of ['diagnosis', 'therapeutic_plan', 'custom', 'allergies_medications']) assert.deepEqual(snapshot[key], baseline[key]);
        assert.equal((await intake.save(payload)).status, 409);
        assert.equal((await intake.save({ ...body, consultation: { reason: 'Duplicate new draft' } })).status, 409);
        assert.equal((await intake.get({ ...body, id_business: 'QA_BUSINESS_PROFESSIONAL' })).status, 403);
        assert.equal((await historyDao.getById({ ...body, id_clinical_history: historyId })).status, 403);
        assert.equal((await historyDao.createDraft({ ...body, clinical_snapshot_json: {} })).status, 403);
        assert.equal((await historyDao.finalize({ ...body, id_clinical_history: historyId, expected_revision: 1 })).status, 403);
        await connection.query("UPDATE clinical_histories SET status='FINALIZED' WHERE id_clinical_history=?", [historyId]);
        const closed = await intake.get(body); assert.equal(closed.status, 200); assert.equal(closed.data.editable, false); assert.equal(closed.data.consultation.reason, '');
        assert.equal((await intake.save({ ...payload, expected_revision: 1 })).status, 409);

        // Seeding can open operations from its module permission but never economics,
        // full clinical access or intake. Explicit family denials survive reseeding.
        await seedDashboardPermissions(business, actor);
        let access = await resolveDashboardAccess(business, actor);
        assert.equal(access.families.administrative, true); assert.equal(access.families.clinical, false); assert.equal(access.families.financial, false);
        assert.equal(access.administrativeTeam, false);
        await setPermission('dashboard.operations', 0); await seedDashboardPermissions(business, actor);
        assert.equal((await resolveDashboardAccess(business, actor)).error.status, 403);
        await setPermission('dashboard.financial', 1);
        assert.equal((await resolveDashboardAccess(business, actor)).error.status, 403, 'Non-professional financial requires institutional scope');
        await setPermission('dashboard.scope.all', 1);
        access = await resolveDashboardAccess(business, actor); assert.equal(access.families.financial, true);
        assert.equal((await resolveDashboardAccess('QA_BUSINESS_PROFESSIONAL', actor)).error.status, 403);
        // Role reassignment must use the safe tenant reception defaults even if
        // there were no reception users at migration time. Custom exceptions survive.
        const [receptionRoles] = await connection.query("SELECT id_rol FROM rol WHERE code IN ('reception','receptionist') AND active=1 ORDER BY code LIMIT 1");
        assert.equal(receptionRoles.length, 1, 'Existing reception catalog role required');
        const receptionRole = receptionRoles[0].id_rol;
        await connection.query('UPDATE login SET id_rol=? WHERE id_login=?', [receptionRole, actor]);
        await seedDashboardPermissions(business, actor);
        const effective = require('../../src/util/effectivePermissions');
        const receptionCodes = (await effective.rows(actor, { enabledCatalog: true })).map(row => row.code);
        assert.equal(receptionCodes.includes('clinical_history.view'), false);
        assert.equal(receptionCodes.includes('clinical_history.edit_draft'), false);
        assert.equal(receptionCodes.includes('clinical_history.finalize'), false);
        assert.equal(receptionCodes.includes('prescriptions.issue'), false);
        assert.equal(receptionCodes.includes('documents.sign'), false);
        assert.equal(receptionCodes.includes('px.dates'), true);
        await setPermission('clinical_history.view', 1, receptionRole);
        await seedDashboardPermissions(business, actor);
        assert.equal(await effective.hasPermission(actor, 'clinical_history.view'), true, 'Deliberate tenant exception preserved');
        await setPermission('clinical_history.view', 0, receptionRole);
        await setPermission('clinical_history.intake', 1, receptionRole);
        await seedDashboardPermissions(business, actor);
        assert.equal(await effective.hasPermission(actor, 'clinical_history.intake'), true, 'Intake grant preserved without full history');
        await connection.rollback();
        const [remains] = await connection.query('SELECT id_person FROM person WHERE id_person=?', [patient]); assert.equal(remains.length, 0);
        console.log('PASS S17/S18 live: intake-only actor cannot read full history/finalize; explicit active recipient, minimal catalog, author/responsible separated, actual Home own count/link, reassignment blocked; revision zero/save/conflict, strict patch, closed/foreign tenant refused; operations/defaults and explicit exceptions preserved. One connection; all fixtures rolled back and absence verified.');
    } finally { await connection.rollback(); await connection.end(); }
})().catch(error => { console.error('S17 access/intake live:', error.code || error.message, error.code === 'ERR_ASSERTION' ? error.stack : ''); process.exitCode = 1; });

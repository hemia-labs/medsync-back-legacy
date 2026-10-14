const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { v4: uuid } = require('uuid');
const config = require('../../src/config/config');

(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    let serial = 0;
    const db = {
        async transaction() {
            const name = `s16_history_${++serial}`; await connection.query(`SAVEPOINT ${name}`);
            return { async commit() { await connection.query(`RELEASE SAVEPOINT ${name}`); }, async rollback() { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); } };
        },
        async query(sql, options = {}) {
            const args = [];
            const query = sql.replace(/:([A-Za-z_]\w*)/g, (_, key) => { assert.ok(Object.hasOwn(options.replacements || {}, key), `Missing ${key}`); args.push(options.replacements[key]); return '?'; });
            const [rows] = await connection.query(query, args);
            return Array.isArray(rows) ? rows : [rows.affectedRows];
        }
    };
    const id = require.resolve('../../src/db/Sequelize.connection');
    require.cache[id] = { id, filename: id, loaded: true, exports: db };
    try {
        await connection.beginTransaction();
        const business = 'QA_BUSINESS_CLINICAL';
        const [doctors] = await connection.execute(`SELECT d.*, l.name FROM doctor_professional_profile d JOIN login l ON l.id_login = d.id_login
            WHERE d.id_business = ? AND l.id_business = ? AND d.is_active = 1 AND l.active = 1 AND l.id_login LIKE 'QAC_DOCTOR_%' ORDER BY l.id_login LIMIT 2`, [business, business]);
        assert.equal(doctors.length, 2, 'Requires two QA clinical professional fixtures');
        const actor = doctors[0], responsible = doctors[1], patient = uuid(), history = uuid();
        await connection.execute('INSERT INTO person (id_person, id_business, name, surname, created_by) VALUES (?, ?, ?, ?, ?)', [patient, business, 'QA S16', 'ROLLBACK', actor.id_login]);
        await connection.execute(`INSERT INTO allergy (id_allergy, id_business, id_patient, has_allergy, description, review_status, revision, reviewed_by, created_by) VALUES (?, ?, ?, 0, '', 'NONE_KNOWN', 1, ?, ?)`, [uuid(), business, patient, actor.id_login, actor.id_login]);
        const snapshot = { consultation: { reason: 'Original QA capture' } };
        const schema = { sections: [{ key: 'consultation', label: 'Consulta', fields: [{ key: 'reason', required: true, type: 'text' }] }] };
        await connection.execute(`INSERT INTO clinical_histories (id_clinical_history, business_id, patient_id, doctor_responsible_user_id, doctor_responsible_profile_id, created_by_user_id, clinical_snapshot_json, template_snapshot_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [history, business, patient, responsible.id_login, responsible.id_doctor_professional_profile, actor.id_login, JSON.stringify(snapshot), JSON.stringify(schema)]);
        await connection.execute(`INSERT INTO patient_documents (id_patient_document, id_business, id_person, document_type, status, title, signed_at, created_by)
            VALUES (?, ?, ?, 'SENSITIVE_DATA_CONSENT', 'FIRMADO', 'QA S16 rollback fixture', NOW(), ?)`, [uuid(), business, patient, actor.id_login]);
        const dao = require('../../src/Dao/mysql/clinicalHistory.dao');
        const context = { id_clinical_history: history, id_business: business, id_login: actor.id_login };
        const first = await dao.getById(context); assert.equal(first.status, 200, first.message);
        assert.equal(first.data.history.revision, 0);
        const payload = { ...context, expected_revision: 0, doctor_responsible_user_id: responsible.id_login, clinical_snapshot_json: { consultation: { reason: 'Saved QA capture' } } };
        const saved = await dao.updateDraft(payload); assert.equal(saved.status, 200, saved.message); assert.equal(saved.data.history.revision, 1);
        assert.equal((await dao.updateDraft({ ...payload, clinical_snapshot_json: { consultation: { reason: 'Stale capture' } } })).status, 409);
        assert.equal((await dao.finalize({ ...context, expected_revision: 0 })).status, 409);
        const final = await dao.finalize({ ...context, expected_revision: 1 }); assert.equal(final.status, 200, final.message);
        assert.equal(final.data.history.status, 'FINALIZED'); assert.equal(final.data.history.revision, 2);
        assert.equal(final.data.doctor.id_login, responsible.id_login); assert.equal(final.data.finalizer.id_login, actor.id_login);
        await connection.execute('UPDATE doctor_professional_profile SET professional_name = ?, professional_license = ?, is_active = 0 WHERE id_doctor_professional_profile = ?', ['QA changed after finalization', 'QA-changed', responsible.id_doctor_professional_profile]);
        await connection.execute('UPDATE login SET active = 0 WHERE id_login = ?', [responsible.id_login]);
        const reread = await dao.getById(context); assert.equal(reread.status, 200, reread.message);
        assert.equal(reread.data.doctor.professional_name, responsible.professional_name);
        assert.equal(reread.data.doctor.professional_license, responsible.professional_license);
        assert.equal(reread.data.history.clinical_snapshot_json.consultation.reason, 'Saved QA capture');
        await connection.execute(`INSERT INTO business_role_permission (id_business, id_rol, id_cat_permission, active)
            SELECT l.id_business, l.id_rol, cp.id_cat_permission, 1 FROM login l CROSS JOIN cat_permission cp
            WHERE l.id_login = ? AND l.id_business = ? AND cp.code = 'clinical_history.cancel'
            ON DUPLICATE KEY UPDATE active = 1`, [actor.id_login, business]);
        assert.equal((await dao.cancel({ ...context, expected_revision: 1 })).status, 409);
        assert.equal((await dao.cancel({ ...context, expected_revision: 2 })).status, 400);
        const versions = await dao.listVersionsByPatient({ ...context, patient_id: patient }); assert.equal(versions.status, 200, versions.message);
        assert.equal(versions.data.versions[0].doctor_name_snapshot, responsible.professional_name);
        const cross = await dao.updateDraft({ ...payload, id_business: 'QA_BUSINESS_PROFESSIONAL', expected_revision: 2 }); assert.notEqual(cross.status, 200);
        console.log('PASS S16 history live SQL: revision increment, stale edit/finalize rejection, distinct closure identities, profile change/deactivation survival, no finalized cancellation and tenant isolation. One connection; QA records, profile changes and temporary cancellation permission rolled back.');
    } finally { await connection.rollback(); await connection.end(); }
})().catch(error => {
    console.error('S16 history live QA:', error.code || error.message,
        error.code === 'ER_NO_DEFAULT_FOR_FIELD' ? error.sqlMessage : error.code === 'ERR_ASSERTION' ? error.stack : '');
    process.exitCode = 1;
});

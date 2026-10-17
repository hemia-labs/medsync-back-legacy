// Real SQL and DAO behavior, one connection, all synthetic data rolled back.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');
const { v4: uuid } = require('uuid');
(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    let counter = 0;
    try {
        await connection.beginTransaction();
        const db = {
            async transaction() { const name = `cd13_${++counter}`; await connection.query(`SAVEPOINT ${name}`); return { async commit() { await connection.query(`RELEASE SAVEPOINT ${name}`); }, async rollback() { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); } }; },
            async query(sql, options = {}) {
                const args = [];
                const text = sql.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => { args.push(options.replacements[key]); return '?'; });
                const [rows] = await connection.execute(text, args);
                return rows;
            }
        };
        const connectionPath = require.resolve('../../src/db/Sequelize.connection');
        require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: db };
        const dao = require('../../src/Dao/mysql/patientAllergy.dao');
        const tenant = 'QA_BUSINESS_CLINICAL', patient = uuid(), user = 'QA_CD13_ACTOR';
        await connection.execute('INSERT INTO person (id_person,id_business,name,surname,created_by) VALUES (?,?,?,?,?)', [patient, tenant, 'QA CD13', 'ROLLBACK', user]);
        const draft = uuid(), finalized = uuid();
        const historical = JSON.stringify({ allergies_medications: { allergies: 'Dato historico QA' }, observations: { general: 'Conservar texto' } });
        for (const [id, status, version] of [[draft, 'DRAFT', 1], [finalized, 'FINALIZED', 2]]) await connection.execute('INSERT INTO clinical_histories (id_clinical_history,business_id,patient_id,created_by_user_id,status,version_number,clinical_snapshot_json) VALUES (?,?,?,?,?,?,?)', [id, tenant, patient, user, status, version, historical]);
        let revision = 0;
        for (const status of ['HAS_ALLERGIES', 'UNKNOWN', 'NONE_KNOWN']) {
            const response = await dao.update({ patient_id: patient, id_business: tenant, id_login: user, review_status: status, description: status === 'NONE_KNOWN' ? '' : 'Dato ficticio de prueba', expected_revision: revision });
            assert.equal(response.status, 200); revision++;
            assert.equal(response.data.revision, revision);
            const [histories] = await connection.execute('SELECT status,clinical_snapshot_json FROM clinical_histories WHERE patient_id=? ORDER BY version_number', [patient]);
            assert.equal(JSON.parse(histories[0].clinical_snapshot_json).allergies_medications.allergy_status, status);
            assert.equal(JSON.parse(histories[0].clinical_snapshot_json).observations.general, 'Conservar texto');
            assert.equal(histories[1].clinical_snapshot_json, historical, 'Finalized copy is unchanged');
        }
        const conflict = await dao.update({ patient_id: patient, id_business: tenant, id_login: user, review_status: 'HAS_ALLERGIES', description: 'No debe reemplazar', expected_revision: 0 });
        assert.equal(conflict.status, 409);
        const crossTenant = await dao.update({ patient_id: patient, id_business: 'QA_BUSINESS_PROFESSIONAL', id_login: user, review_status: 'NONE_KNOWN', description: '', expected_revision: revision });
        assert.equal(crossTenant.status, 403);
        await connection.execute('UPDATE allergy SET has_allergy=1,description=? WHERE id_patient=?', ['Formulario desactualizado', patient]);
        const preserved = await dao.getCurrent(patient, tenant);
        assert.equal(preserved.review_status, 'NONE_KNOWN'); assert.equal(preserved.has_allergy, 0); assert.equal(preserved.description, '');
        const [events] = await connection.execute('SELECT COUNT(*) AS n FROM patient_allergy_events WHERE patient_id=?', [patient]);
        assert.equal(events[0].n, 3);
        console.log('PASS CD13 live SQL: 3 states, draft synchronization, finalized preservation, revision conflict, tenant isolation, legacy trigger and audit. Synthetic fixture rolled back; one connection.');
    } finally { await connection.rollback(); await connection.end(); }
})().catch(error => { console.error('CD13 live QA failed:', error.code || error.message); process.exitCode = 1; });

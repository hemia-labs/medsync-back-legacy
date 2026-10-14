// Exercises actual SQL and patient DAO with one connection; fixtures are always rolled back.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { injectReplacements } = require('sequelize/lib/utils/sql');
const dialect = { name: 'mysql', TICK_CHAR_LEFT: '`', TICK_CHAR_RIGHT: '`', canBackslashEscape: () => true, supports: {} };
const { v4: uuid } = require('uuid');
const config = require('../../src/config/config');
(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    let serial = 0, statements = [];
    const db = {
        async transaction() {
            const name = `s16_patient_${++serial}`; await connection.query(`SAVEPOINT ${name}`);
            return { async commit() { await connection.query(`RELEASE SAVEPOINT ${name}`); }, async rollback() { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); } };
        },
        async query(sql, options = {}) {
            assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|\bCALL\b/i, 'No destructive SQL or procedure with internal commits in this verification');
            statements.push(sql);
            const query = injectReplacements(sql, dialect, options.replacements);
            const [rows] = await connection.query(query); return rows;
        }
    };
    const dbPath = require.resolve('../../src/db/Sequelize.connection');
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
    const dao = require('../../src/Dao/mysql/px.dao');
    const business = 'QA_BUSINESS_CLINICAL', user = 'QA_S16_PATIENT_ACTOR';
    let patient;
    try {
        await connection.beginTransaction();
        const [tenants] = await connection.query('SELECT id_business FROM business WHERE id_business = ?', [business]);
        assert.equal(tenants.length, 1, 'Expected QA tenant');
        const created = await dao.pxCreateMinimal({ id_business: business, id_login: user, person: { name: `QA S16 ${uuid()}`, surname: 'ROLLBACK', birthday: '2000-02-01', age: 26, telephone: '5555555555' }, address: { direction: 'QA initial' } });
        assert.equal(created.status, 200, created.message); patient = created.data.id_person;
        await connection.query('UPDATE person SET id_signature=?,name_signature=? WHERE id_person=?', ['qa-private-signature', 'QA private name', patient]);
        await connection.query('UPDATE query SET current_condition=?,reason_consultation=?,pulse=? WHERE id_person=?', ['QA PRIVATE condition', 'QA PRIVATE consultation', 'QA PRIVATE pulse', patient]);
        await connection.query("UPDATE allergy SET review_status='HAS_ALLERGIES',has_allergy=1,description=?,revision=1 WHERE id_patient=?", ['QA PRIVATE allergy', patient]);
        await connection.query('INSERT INTO clinical_histories (id_clinical_history,business_id,patient_id,created_by_user_id,status,version_number,clinical_snapshot_json) VALUES (?,?,?,?,?,?,?)', [uuid(), business, patient, user, 'FINALIZED', 1, JSON.stringify({ private: 'QA frozen history' })]);
        await connection.query('INSERT INTO appointment (id_appointment,id_business,id_person,appointment_date,start_time,end_time,title) VALUES (?,?,?,?,?,?,?)', [uuid(), business, patient, '2030-01-01', '09:00:00', '09:30:00', 'QA rollback appointment']);
        const snapshot = async () => {
            const result = {};
            for (const [table, key] of [['query', 'id_person'], ['allergy', 'id_patient'], ['clinical_histories', 'patient_id'], ['appointment', 'id_person']]) {
                const [rows] = await connection.query(`SELECT * FROM ${table} WHERE ${key}=?`, [patient]); result[table] = rows;
            }
            const [signatures] = await connection.query('SELECT id_signature,name_signature FROM person WHERE id_person=?', [patient]); result.signatures = signatures;
            return JSON.stringify(result);
        };
        const baseline = await snapshot();
        statements = [];
        const admin = await dao.getPxById(patient, business);
        assert.equal(admin.status, 200, admin.message);
        assert.deepEqual(Object.keys(admin.data).sort(), ['access', 'address', 'person']);
        assert.equal(admin.data.access.clinical, false);
        assert.equal(JSON.stringify(admin.data).includes('PRIVATE'), false);
        assert.equal(admin.data.person.id_signature, undefined);
        assert.equal(statements.length, 1);
        assert.doesNotMatch(statements[0], /LEFT JOIN query|allergy|pathological|signature/);
        const clinical = await dao.getPxById(patient, business, { clinical: true });
        assert.equal(clinical.status, 200, clinical.message);
        assert.equal(clinical.data.query.current_condition, 'QA PRIVATE condition');
        assert.equal(clinical.data.allergy.description, 'QA PRIVATE allergy');
        assert.equal(clinical.data.person.id_signature, 'qa-private-signature');
        assert.equal((await dao.getPxById(patient, 'QA_BUSINESS_PROFESSIONAL')).status, 404);
        const payload = { id_business: business, id_login: user, person: { ...admin.data.person, birthday: '2000-02-01', name: 'QA S16 changed', id_signature: 'injected-signature', active: 0 }, address: { ...admin.data.address, id_address: 'foreign-address', direction: 'QA changed' }, query: { current_condition: 'INJECTED' }, allergy: { description: 'INJECTED' }, pathological_data: [{ private: 'INJECTED' }] };
        assert.equal((await dao.updateAdministrative(payload)).status, 200);
        assert.equal(await snapshot(), baseline, 'Administrative edit leaves consultation, allergies, signature, final history and appointments byte-identical');
        const after = await dao.getPxById(patient, business);
        assert.equal(after.data.person.name, 'QA S16 changed'); assert.equal(after.data.person.active, 1); assert.equal(after.data.address.direction, 'QA changed');
        assert.equal((await dao.updateAdministrative({ ...payload, id_business: 'QA_BUSINESS_PROFESSIONAL' })).status, 404);
        const beforeDeleteQueries = statements.length;
        assert.equal((await dao.pxForceDelete(patient, business)).status, 403);
        assert.equal(statements.length, beforeDeleteQueries);
        assert.equal((await dao.pxDelete(patient, user, business)).status, 200);
        assert.equal(await snapshot(), baseline, 'Archiving preserves all dependencies');
        assert.equal((await dao.getPxById(patient, business)).data.person.active, 0);
        assert.equal((await dao.getPxSearch('QA S16 changed', business)).data.some(item => item.id_person === patient), false);
        assert.equal((await dao.getPxSearch('QA S16 changed', business, { includeArchived: true })).data.some(item => item.id_person === patient), true);
        assert.equal((await dao.setArchived(patient, user, business, false)).status, 200);
        assert.equal((await dao.getPxById(patient, business)).data.person.active, 1);
        assert.equal(await snapshot(), baseline);
        await connection.rollback();
        const [remaining] = await connection.query('SELECT id_person FROM person WHERE id_person=?', [patient]);
        assert.equal(remaining.length, 0, 'Fixture rollback verified');
        console.log('PASS S16 patient live: real administrative/clinical projections, allowlist editing preserves clinical data/signatures, cross-tenant denial, hard delete disabled, archive/search/restore preserves appointments and histories. One connection; new UUID fixture rolled back and absence verified.');
    } finally { await connection.rollback(); await connection.end(); }
})().catch(error => { console.error('S16 patient live verification failed:', error.message, error.stack && error.stack.split('\n')[1]); process.exitCode = 1; });

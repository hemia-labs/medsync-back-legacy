// Dedicated synthetic fixture. No existing user's role/data/credentials are changed.
'use strict';
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');
const { encript } = require('../../src/util/bcrypt');
const business = 'QA_BUSINESS_CLINICAL', actor = 'QA_S18_RECEPTION', role = 'QA_S18_RECEPTION_ROLE', patient = 'QA_S18_PATIENT';
const owner = 'QA_S18_BROWSER_FIXTURE';
const command = process.argv[2];
const permissions = ['px.all', 'px.dates', 'clinical_history.intake', 'dashboard.operations'];
(async () => {
    assert.ok(['setup', 'retire', 'revoke-intake', 'restore-intake', 'status'].includes(command), 'Use setup|retire|revoke-intake|restore-intake|status');
    const db = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    try {
        const [tenants] = await db.query('SELECT id_business FROM business WHERE id_business=?', [business]);
        assert.equal(tenants.length, 1, 'Synthetic QA tenant required');
        const [actors] = await db.query('SELECT created_by FROM login WHERE id_login=?', [actor]);
        const [patients] = await db.query('SELECT created_by FROM person WHERE id_person=?', [patient]);
        assert.ok(actors.every(row => row.created_by === owner) && patients.every(row => row.created_by === owner), 'Never modify an unrelated record');
        await db.beginTransaction();
        if (command === 'setup') {
            assert.equal(actors.length, 0, 'Fixture already exists; do not overwrite its work');
            assert.equal(patients.length, 0, 'Fixture already exists');
            const [collision] = await db.query('SELECT id_login FROM login WHERE telephone=?', ['5510000291']);
            assert.equal(collision.length, 0, 'QA phone already in use');
            await db.query('INSERT INTO rol(id_rol,code,desc_rol,active) VALUES(?,?,?,1)', [role, 'qa_s18_reception', 'Recepcion QA S18 (temporal)']);
            await db.query('INSERT INTO login(id_login,id_business,id_rol,name,telephone,email,password,locked,active,created_at,created_by) VALUES(?,?,?,?,?,?,?,0,1,NOW(),?)',
                [actor, business, role, 'QA S18 Recepcion', '5510000291', 'qa-s18-reception@example.invalid', await encript('PruebaDummyQA123'), owner]);
            for (const code of permissions) {
                const [catalog] = await db.query('SELECT id_cat_permission FROM cat_permission WHERE code=? AND active=1', [code]);
                assert.equal(catalog.length, 1, `Missing permission ${code}`);
                await db.query('INSERT INTO business_role_permission(id_business,id_rol,id_cat_permission,active) VALUES(?,?,?,1)', [business, role, catalog[0].id_cat_permission]);
            }
            await db.query('INSERT INTO person(id_person,id_business,code,name,surname,birthday,age,active,created_at,created_by) VALUES(?,?,?,?,?,?,?,1,NOW(),?)',
                [patient, business, 'S18QA', 'QA S18', 'Entrega ficticia', '2000-01-01', 26, owner]);
            await db.query("INSERT INTO allergy(id_allergy,id_business,id_patient,has_allergy,description,review_status,revision,created_by) VALUES(?,?,?,0,'','UNKNOWN',0,?)", ['QA_S18_ALLERGY', business, patient, owner]);
        } else if (command === 'retire') {
            assert.equal(actors.length, 1);
            await db.query('UPDATE login SET active=0,updated_at=NOW(),updated_by=? WHERE id_login=? AND created_by=?', [owner, actor, owner]);
            await db.query('UPDATE session SET active=0,`last`=0,updated_at=NOW(),updated_by=? WHERE id_login=?', [owner, actor]);
            await db.query('UPDATE person SET active=0,updated_at=NOW(),updated_by=? WHERE id_person=? AND created_by=?', [owner, patient, owner]);
            await db.query("UPDATE clinical_histories SET deleted_at=NOW(),updated_by_user_id=? WHERE patient_id=? AND business_id=? AND created_by_user_id=? AND status='DRAFT'", [actor, patient, business, actor]);
            await db.query('UPDATE rol SET active=0 WHERE id_rol=?', [role]);
            await db.query('UPDATE business_role_permission SET active=0 WHERE id_business=? AND id_rol=?', [business, role]);
        } else if (command.endsWith('-intake')) {
            assert.equal(actors.length, 1);
            await db.query("UPDATE business_role_permission brp JOIN cat_permission cp ON cp.id_cat_permission=brp.id_cat_permission SET brp.active=? WHERE brp.id_business=? AND brp.id_rol=? AND cp.code='clinical_history.intake'", [command === 'restore-intake' ? 1 : 0, business, role]);
        }
        await db.commit();
        const [status] = await db.query('SELECT p.active AS patient_active,l.active AS actor_active,(SELECT COUNT(*) FROM clinical_histories h WHERE h.patient_id=p.id_person) AS histories FROM person p JOIN login l ON l.id_login=? WHERE p.id_person=?', [actor, patient]);
        console.log(JSON.stringify({ command, syntheticOnly: true, patient, actor, status }));
    } catch (error) { await db.rollback(); throw error; }
    finally { await db.end(); }
})().catch(error => { console.error('S18 fixture:', error.code || error.message); process.exitCode = 1; });

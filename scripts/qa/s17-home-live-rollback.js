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
        const [doctors] = await connection.execute("SELECT d.* FROM doctor_professional_profile d JOIN login l ON l.id_login=d.id_login WHERE d.id_business=? AND l.active=1 AND d.is_active=1 AND l.id_login LIKE 'QAC_DOCTOR_%' ORDER BY l.id_login LIMIT 2",[business]);
        assert.equal(doctors.length,2); const actor=doctors[0],other=doctors[1],patient=uuid();
        // Explicit, temporary metric grants; restored by outer rollback.
        await connection.query(`INSERT INTO business_role_permission (id_business,id_rol,id_cat_permission,active)
            SELECT l.id_business,l.id_rol,cp.id_cat_permission, IF(cp.code='dashboard.scope.all',0,1) FROM login l CROSS JOIN cat_permission cp
            WHERE l.id_login=? AND cp.code IN ('dashboard.clinical','dashboard.operations','dashboard.scope.all','clinical_history.view','documents.view','px.all','px.dates','prescriptions.view.all')
            ON DUPLICATE KEY UPDATE active=VALUES(active)`,[actor.id_login]);
        const dao=require('../../src/Dao/mysql/homeContinuity.dao');
        const before=await dao.summary(business,actor.id_login);assert.equal(before.status,200,before.message);
        assert.equal(before.data.scope.mode,'own'); assert.equal(before.data.sections.recentPatients.available,false);
        assert.equal((await dao.summary(business,actor.id_login,{scope:'tenant'})).status,403);
        assert.equal((await dao.summary(business,actor.id_login,{scope:'bad'})).status,400);
        assert.equal((await dao.summary('QA_BUSINESS_PROFESSIONAL',actor.id_login)).status,403);
        await connection.query('INSERT INTO person (id_person,id_business,name,surname,created_by) VALUES (?,?,?,?,?)',[patient,business,'QA S17','ROLLBACK',actor.id_login]);
        const makeDoc=async(responsible=actor.id_login,status='BORRADOR')=>{const id=uuid();await connection.query(`INSERT INTO patient_documents (id_patient_document,id_business,id_person,document_type,status,title,responsible_doctor_user_id,created_by) VALUES (?,?,?,'SENSITIVE_DATA_CONSENT',?,'QA S17 rollback',?,?)`,[id,business,patient,status,responsible,other.id_login]);return id;};
        const request=async(doc,status,hours,daysAgo=0)=>connection.query(`INSERT INTO document_signature_requests (id_document_signature_request,id_business,id_person,id_patient_document,document_type,signature_role,channel,status,token_hash,expires_at,created_at) VALUES (?,?,?,?,'SENSITIVE_DATA_CONSENT','PATIENT','qr',?,?,DATE_ADD(NOW(),INTERVAL ? HOUR),DATE_SUB(NOW(),INTERVAL ? DAY))`,[uuid(),business,patient,doc,status,require('crypto').randomBytes(32).toString('hex'),hours,daysAgo]);
        await request(await makeDoc(),'pending',96);
        await request(await makeDoc(),'pending',24);
        await request(await makeDoc(),'opened',24);
        await request(await makeDoc(),'pending',-1);
        await request(await makeDoc(),'expired',-1);
        const renewed=await makeDoc();await request(renewed,'expired',-48,2);await request(renewed,'pending',96);
        const signed=await makeDoc();await request(signed,'expired',-1);
        await connection.query(`INSERT INTO patient_document_signatures (id_patient_document_signature,id_patient_document,id_business,signature_role,signed_at) VALUES (?,?,?,'PATIENT',NOW())`,[uuid(),signed,business]);
        await request(await makeDoc(actor.id_login,'FIRMADO'),'expired',-1);
        await request(await makeDoc(other.id_login),'pending',96);
        const sameSecond=await makeDoc();await request(sameSecond,'revoked',96);await request(sameSecond,'pending',96);
        const placeholder=await makeDoc();await request(placeholder,'pending',24);
        await connection.query(`INSERT INTO patient_document_signatures (id_patient_document_signature,id_patient_document,id_business,signature_role,signature_image) VALUES (?,?,?,'PATIENT','')`,[uuid(),placeholder,business]);
        await connection.query(`INSERT INTO clinical_histories (id_clinical_history,business_id,patient_id,doctor_responsible_user_id,created_by_user_id,clinical_snapshot_json) VALUES (?,?,?,?,?,'{}'),(?,?,?,?,?,'{}')`,[uuid(),business,patient,actor.id_login,other.id_login,uuid(),business,patient,other.id_login,actor.id_login]);
        const after=await dao.summary(business,actor.id_login);assert.equal(after.status,200,after.message);
        const a=after.data.sections,b=before.data.sections;
        assert.equal(a.signatures.total-b.signatures.total,8);
        for(const key of ['pending','expiringSoon','expired']) assert.equal(a.signatures.cards.find(c=>c.key===key).value-b.signatures.cards.find(c=>c.key===key).value,key==='expired'?2:3,key);
        assert.equal(a.drafts.cards.find(c=>c.key==='clinical').value-b.drafts.cards.find(c=>c.key==='clinical').value,1,'Responsible doctor, not creator');
        const appointment=await dao.appointments(business,actor.id_login,{date:new Date().toISOString().slice(0,10),doctor_profile_id:other.id_doctor_professional_profile});
        assert.equal(appointment.status,200,appointment.message);
        assert.ok(appointment.data.every(row=>(row.doctor_profile_id||row.doctorProfileId)===actor.id_doctor_professional_profile));
        assert.equal((await dao.appointments(business,actor.id_login,{scope:'tenant',date:'2026-10-13'})).status,403);
        console.log('PASS S17 Home live SQL: own/tenant guards, actor tenant, responsible not capturer, opened/pending/expired disjoint signatures, renewal/local signing/completed exclusion, scoped agenda. One connection; all fixtures/grants rolled back.');
    } finally { await connection.rollback(); await connection.end(); }
})().catch(error => { console.error('S17 Home QA:',error.code||error.message,error.code==='ERR_ASSERTION'?error.stack:''); process.exitCode=1; });

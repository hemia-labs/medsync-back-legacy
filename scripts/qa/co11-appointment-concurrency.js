// Two deliberate concurrent reservations through the real DAO/transaction pool.
// Own UUID-labelled dummy appointment is removed in finally; no existing row is removed.
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const { QueryTypes } = require('sequelize');
if (process.env.QA_APPOINTMENT_ISOLATED !== '1' || !['127.0.0.1','localhost'].includes(process.env.DB_HOST)
    || !/^qa_/.test(process.env.DB_NAME || '') || Number(process.env.DB_PORT) === 3306) throw Error('Explicit loopback QA database required');
const db = require('../../src/db/Sequelize.connection');
const dao = require('../../src/Dao/mysql/appointment.Dao');
const title = `QA_CO11_CONCURRENCY_${uuid()}`;
(async () => {
    let business, actor;
    const requestIds = [uuid(), uuid()];
    try {
        const rows = await db.query(`SELECT p.id_business, d.id_doctor_professional_profile, d.id_login
            FROM person p JOIN doctor_professional_profile d ON d.id_business = p.id_business
            JOIN appointment_config c ON c.id_business = d.id_business AND c.doctor_profile_id = d.id_doctor_professional_profile
            WHERE p.id_person = 'QAC_PATIENT_01' AND d.is_active = 1 AND c.enabled = 1 LIMIT 1`, {type:QueryTypes.SELECT});
        assert.equal(rows.length,1,'Activate one QA clinical agenda before the concurrency check.');
        business=rows[0].id_business;actor=rows[0].id_login;
        const body={id_business:business,id_login:actor,appointment:{doctorProfileId:rows[0].id_doctor_professional_profile,patientId:'QAC_PATIENT_01',date:'2030-01-07',startTime:'09:00',endTime:'09:30',status:'confirmed',title,source:'qa_co11'}};
        const requests = requestIds.map(request_id => ({ ...body, request_id }));
        const results=await Promise.all(requests.map(request => dao.save(request)));
        assert.equal(results.filter(r=>r.status===200).length,1,results.map(r=>r.message).join('; '));
        assert.equal(results.filter(r=>r.status===400).length,1);
        const winner = results.findIndex(r => r.status === 200);
        const retry = await dao.save(requests[winner]);
        assert.equal(retry.status, 200);
        assert.equal(retry.data[0].id, results[winner].data[0].id, 'Retry must return the same appointment');
        const count=await db.query('SELECT COUNT(*) n FROM appointment WHERE id_business = :business AND title = :title AND active = 1',{replacements:{business,title},type:QueryTypes.SELECT});
        assert.equal(Number(count[0].n),1);
        console.log('PASS CO11 real concurrent transactions: one reservation, one conflict for the same doctor/interval. Two intentional simultaneous operations; own dummy row cleaned up.');
    } finally {
        if (business && actor) {
            await db.query('DELETE FROM appointment_write_request WHERE id_business=:business AND actor_id=:actor AND request_id IN (:ids)', { replacements: { business, actor, ids: requestIds } });
            await db.query('DELETE a FROM appointment_audit a JOIN appointment p ON p.id_appointment=a.appointment_id AND p.id_business=a.id_business WHERE p.id_business=:business AND p.title=:title AND p.created_by=:actor AND p.source=:source', { replacements: { business, title, actor, source: 'qa_co11' } });
        }
        if(business && actor)await db.query('DELETE FROM appointment WHERE id_business = :business AND title = :title AND created_by = :actor AND source = :source',{replacements:{business,title,actor,source:'qa_co11'},type:QueryTypes.DELETE});
        await db.close();
    }
})().catch(error=>{console.error(error.message);process.exitCode=1;});

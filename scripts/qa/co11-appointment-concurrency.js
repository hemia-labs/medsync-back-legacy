// Two deliberate concurrent reservations through the real DAO/transaction pool.
// Own UUID-labelled dummy appointment is removed in finally; no existing row is removed.
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const { QueryTypes } = require('sequelize');
const db = require('../../src/db/Sequelize.connection');
const dao = require('../../src/Dao/mysql/appointment.Dao');
const title = `QA_CO11_CONCURRENCY_${uuid()}`;
(async () => {
    let business, actor;
    try {
        const rows = await db.query(`SELECT p.id_business, d.id_doctor_professional_profile, d.id_login
            FROM person p JOIN doctor_professional_profile d ON d.id_business = p.id_business
            JOIN appointment_config c ON c.id_business = d.id_business AND c.doctor_profile_id = d.id_doctor_professional_profile
            WHERE p.id_person = 'QAC_PATIENT_01' AND d.is_active = 1 AND c.enabled = 1 LIMIT 1`, {type:QueryTypes.SELECT});
        assert.equal(rows.length,1,'Activate one QA clinical agenda before the concurrency check.');
        business=rows[0].id_business;actor=rows[0].id_login;
        const body={id_business:business,id_login:actor,appointment:{doctorProfileId:rows[0].id_doctor_professional_profile,patientId:'QAC_PATIENT_01',date:'2030-01-07',startTime:'09:00',endTime:'09:30',status:'confirmed',title,source:'qa_co11'}};
        const results=await Promise.all([dao.save(body),dao.save(body)]);
        assert.equal(results.filter(r=>r.status===200).length,1,results.map(r=>r.message).join('; '));
        assert.equal(results.filter(r=>r.status===400).length,1);
        const count=await db.query('SELECT COUNT(*) n FROM appointment WHERE id_business = :business AND title = :title AND active = 1',{replacements:{business,title},type:QueryTypes.SELECT});
        assert.equal(Number(count[0].n),1);
        console.log('PASS CO11 real concurrent transactions: one reservation, one conflict for the same doctor/interval. Two intentional simultaneous operations; own dummy row cleaned up.');
    } finally {
        if(business && actor)await db.query('DELETE FROM appointment WHERE id_business = :business AND title = :title AND created_by = :actor AND source = :source',{replacements:{business,title,actor,source:'qa_co11'},type:QueryTypes.DELETE});
        await db.close();
    }
})().catch(error=>{console.error(error.message);process.exitCode=1;});

const { QueryTypes } = require('sequelize');
const db = require('../../db/Sequelize.connection');
const time = require('../pulse/time');

async function followUps(body, patientId = null) {
    const [config] = await db.query('SELECT timezone FROM appointment_config WHERE id_business=:business AND doctor_profile_id IS NULL AND active=1 LIMIT 1', { replacements: { business: body.id_business }, type: QueryTypes.SELECT });
    const today = time.date(Date.now(), time.timeZone(config && config.timezone).name);
    const rows = await db.query(`SELECT t.id_tracing,t.treatment_after,DATE_FORMAT(t.quote_date_after,'%Y-%m-%d') AS quote_date_after,
        p.id_person,CONCAT_WS(' ',p.name,p.surname) AS name,p.code,p.telephone,
        (SELECT COUNT(*) FROM appointment a WHERE a.id_business=t.id_business AND a.id_person=t.id_person AND a.id_tracing=t.id_tracing AND a.active=1 AND a.status IN ('pending_confirmation','confirmed')) AS open_count,
        (SELECT MAX(a.id_appointment) FROM appointment a WHERE a.id_business=t.id_business AND a.id_person=t.id_person AND a.id_tracing=t.id_tracing AND a.active=1 AND a.status IN ('pending_confirmation','confirmed')) AS appointment_id,
        EXISTS(SELECT 1 FROM appointment a WHERE a.id_business=t.id_business AND a.id_person=t.id_person AND a.id_tracing=t.id_tracing AND a.active=1) AS has_history
        FROM tracing t JOIN person p ON p.id_person=t.id_person AND p.id_business=t.id_business AND p.active=1
        WHERE t.id_business=:business AND t.status='active'
        ${patientId ? 'AND t.id_person=:patient' : `AND t.quote_date_after>=:today AND t.quote_date_after<=DATE_ADD((SELECT MIN(t2.quote_date_after) FROM tracing t2 JOIN person p2 ON p2.id_person=t2.id_person AND p2.id_business=t2.id_business AND p2.active=1 WHERE t2.id_business=:business AND t2.status='active' AND t2.quote_date_after>=:today),INTERVAL 20 DAY)`}
        ORDER BY t.quote_date_after,t.id_tracing`, { replacements: { business: body.id_business, patient: patientId, today }, type: QueryTypes.SELECT });
    return { status: 200, success: true, data: rows, message: 'Seguimientos consultados.' };
}
module.exports = { followUps };

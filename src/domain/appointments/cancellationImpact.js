'use strict';
const { createHash } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const clock = require('../pulse/time');
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && value >= '1000-01-01' && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
function summarize(current, trace, rows, today) {
    if (!current.followUpId) return { state: 'none', losesCoverage: false };
    if (!trace || !validDate(trace.dueDate) || trace.patientActive == null) return { state: 'unknown', losesCoverage: false };
    if (trace.status !== 'active' || Number(trace.patientActive) !== 1) return { state: 'inactive', losesCoverage: false };
    const covers = a => ['pending_confirmation', 'confirmed', 'completed'].includes(a.status) && validDate(a.date) && a.date >= trace.dueDate;
    const remaining = rows.filter(a => a.id !== current.id);
    const remainingCovering = remaining.filter(covers).length;
    const uncertain = remaining.some(a => !['cancelled', 'no_show', 'rescheduled'].includes(a.status) && (!['pending_confirmation', 'confirmed', 'completed'].includes(a.status) || !validDate(a.date)));
    return { state: remainingCovering ? 'covered' : uncertain ? 'unknown' : trace.dueDate < today ? 'uncovered_overdue' : 'uncovered_upcoming',
        losesCoverage: covers(current) && !remainingCovering, remainingCovering };
}
async function evaluate(dao, current, body, transaction, now) {
    const db = require('../../db/Sequelize.connection');
    let result;
    if (!current.followUpId || !current.patientId) result = summarize(current, null, [], null);
    else {
        const replacements = { business: body.id_business, patient: current.patientId, tracing: current.followUpId };
        const select = sql => db.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
        // Match tracing's patient -> tracing lock order. Tenant lock is held by caller.
        const [patient] = await select('SELECT id_person,active FROM person WHERE id_business=:business AND id_person=:patient FOR UPDATE');
        const [trace] = await select("SELECT status,DATE_FORMAT(quote_date_after,'%Y-%m-%d') AS dueDate FROM tracing WHERE id_business=:business AND id_person=:patient AND id_tracing=:tracing FOR UPDATE");
        const rows = await select("SELECT id_appointment AS id,status,DATE_FORMAT(appointment_date,'%Y-%m-%d') AS date FROM appointment WHERE id_business=:business AND id_person=:patient AND id_tracing=:tracing AND active=1 FOR UPDATE");
        const general = await dao.readConfig(body.id_business, null, transaction);
        if (clock.timeZone(general && general.timezone).source !== 'configured') result = { state: 'unknown', losesCoverage: false };
        else result = summarize(current, trace && { ...trace, patientActive: patient && patient.active }, rows, clock.date(now, general.timezone));
    }
    // Operational projection only: never treatment, clinical notes or patient identity.
    return { ...result, token: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
module.exports = { evaluate, summarize };

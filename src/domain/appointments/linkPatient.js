const { createHash } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/Sequelize.connection');
const safe = require('./safeWrites');
const fail = (status, code, message, data = {}) => ({ status, data: { code, ...data }, message });

async function linkPatient(body) {
    const { id_business: business, id_login: actor, id_appointment: id, patientId, revision, request_id: requestId } = body;
    if (typeof patientId !== 'string' || !patientId.trim() || patientId.length > 50) return fail(400, 'INVALID_PATIENT', 'Selecciona un paciente.');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) return fail(428, 'REQUEST_ID_REQUIRED', 'Falta la clave de vinculacion.');
    const hash = createHash('sha256').update(JSON.stringify([id, patientId, Number(revision), body.confirm_completed === true])).digest('hex');
    let transaction;
    try {
        transaction = await db.transaction();
        const query = (sql, args = {}) => safe.query(sql, { business, actor, id, patientId, requestId, ...args }, transaction, /^SELECT/i.test(sql) ? QueryTypes.SELECT : QueryTypes.RAW);
        await query('SELECT id_business FROM business WHERE id_business=:business FOR UPDATE');
        const [receipt] = await query('SELECT * FROM appointment_write_request WHERE id_business=:business AND request_id=:requestId');
        const reject = async result => { await transaction.rollback(); return result; };
        if (receipt) {
            if (receipt.actor_id !== actor || receipt.operation !== 'link_patient' || receipt.payload_hash !== hash) return reject(fail(409, 'REQUEST_REUSED', 'Esta clave ya se uso con otra operacion.'));
            const saved = await safe.get(receipt.appointment_id, business, transaction);
            return reject({ status: 200, success: true, data: [saved], message: 'Vinculo ya guardado.' });
        }
        const [person] = await query('SELECT id_person FROM person WHERE id_person=:patientId AND id_business=:business AND active=1 FOR UPDATE');
        if (!person) return reject(fail(403, 'PATIENT_UNAVAILABLE', 'Paciente no disponible para este consultorio.'));
        await query('SELECT id_appointment FROM appointment WHERE id_appointment=:id AND id_business=:business AND active=1 FOR UPDATE');
        const current = await safe.get(id, business, transaction);
        if (!current) return reject(fail(403, 'APPOINTMENT_UNAVAILABLE', 'Cita no disponible.'));
        const conflict = safe.revisionConflict(revision, current);
        if (conflict) return reject(conflict);
        if (current.status === 'rescheduled') return reject(fail(409, 'APPOINTMENT_REPLACED', 'Abre la cita destino para vincularla.', { appointment: current }));
        if (current.patientId || current.followUpId) return reject(fail(409, 'IMMUTABLE_LINK', 'La identidad de esta cita ya esta vinculada.', { appointment: current }));
        if (current.status === 'completed' && body.confirm_completed !== true) return reject(fail(428, 'COMPLETED_LINK_CONFIRMATION', 'Confirma que esta atencion aparecera en el historial del paciente.'));
        // Update identifiers only: preserve literal snapshots, phone, state and schedule.
        await query('UPDATE appointment SET id_person=:patientId,revision=revision+1,updated_at=NOW(),updated_by=:actor WHERE id_appointment=:id AND id_business=:business');
        await query(`INSERT INTO appointment_audit(id_business,appointment_id,actor_id,operation,revision,changes)
            VALUES(:business,:id,:actor,'link_patient',:revision,:changes)`, { revision: Number(current.revision) + 1, changes: JSON.stringify({ patientId: { from: null, to: patientId } }) });
        await query(`INSERT INTO appointment_write_request(id_business,request_id,actor_id,operation,payload_hash,appointment_id)
            VALUES(:business,:requestId,:actor,'link_patient',:hash,:id)`, { hash });
        const saved = await safe.get(id, business, transaction);
        await transaction.commit();
        return { status: 200, success: true, data: [saved], message: 'Paciente vinculado. Se conservaron los datos de la cita.' };
    } catch (_) {
        if (transaction && !transaction.finished) await transaction.rollback();
        return fail(500, 'LINK_UNCONFIRMED', 'No se pudo confirmar el vinculo. Reintenta la misma operacion.');
    }
}
module.exports = { linkPatient };

const { createHash, randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/Sequelize.connection');
const { resolveProfessional } = require('../../util/professionalContext');
const { validateAppointment } = require('./agendaRules');
const policy = require('./writePolicy');
const cancellationImpact = require('./cancellationImpact');
const { hasPermission } = require('../../util/effectivePermissions');

const blocking = status => ['pending_confirmation', 'confirmed', 'completed'].includes(status);
const closing = status => ['cancelled', 'no_show'].includes(status);
const fields = {
    doctorProfileId: 'doctor_profile_id', doctorName: 'doctor_name_snapshot', patientId: 'id_person',
    patientName: 'patient_name', contactPhone: 'contact_phone', followUpId: 'id_tracing', date: 'appointment_date',
    startTime: 'start_time', endTime: 'end_time', status: 'status', title: 'title', description: 'description',
    source: 'source', cancellationReason: 'cancellation_reason',
    rescheduledFromAppointmentId: 'rescheduled_from_appointment_id', rescheduledToAppointmentId: 'rescheduled_to_appointment_id'
};
const same = (a, b, keys) => keys.every(k => String(a[k] || '') === String(b[k] || ''));
const scheduleKeys = ['doctorProfileId', 'patientId', 'followUpId', 'date', 'startTime', 'endTime'];
const fail = (status, code, message, data = {}) => ({ status, data: { code, ...data }, message });
const select = `SELECT a.id_appointment AS id, a.revision, a.doctor_profile_id AS doctorProfileId,
    a.doctor_name_snapshot AS doctorName, a.id_person AS patientId,
    COALESCE(NULLIF(a.patient_name,''), TRIM(CONCAT(IFNULL(p.name,''),' ',IFNULL(p.surname,'')))) AS patientName,
    COALESCE(NULLIF(a.contact_phone,''),NULLIF(p.telephone,''),NULLIF(p.local_telephone,'')) AS contactPhone,
    a.id_tracing AS followUpId, DATE_FORMAT(a.appointment_date,'%Y-%m-%d') AS date,
    DATE_FORMAT(a.start_time,'%H:%i') AS startTime, DATE_FORMAT(a.end_time,'%H:%i') AS endTime,
    a.status,a.title,a.description,a.source,a.cancellation_reason AS cancellationReason,
    a.rescheduled_from_appointment_id AS rescheduledFromAppointmentId,
    a.rescheduled_to_appointment_id AS rescheduledToAppointmentId,
    a.blocks_availability AS blocksAvailability,a.created_at AS createdAt,a.updated_at AS updatedAt
    FROM appointment a LEFT JOIN person p ON p.id_person=a.id_person AND p.id_business=a.id_business
    WHERE a.id_business=:business AND a.active=1`;
const query = (sql, replacements, transaction, type = QueryTypes.SELECT) => db.query(sql, { replacements, transaction, type });
async function get(id, business, transaction) {
    return (await query(select + ' AND a.id_appointment=:id', { id, business }, transaction))[0];
}
async function list(body) {
    return query(select + ` AND (:doctor IS NULL OR a.doctor_profile_id=:doctor)
        AND (:patient IS NULL OR a.id_person=:patient) AND (:from IS NULL OR a.appointment_date>=:from)
        AND (:to IS NULL OR a.appointment_date<=:to) ORDER BY a.appointment_date,a.start_time,a.created_at,a.id_appointment`,
    { business: body.id_business, doctor: body.doctor_profile_id || null, patient: body.id_person || null,
        from: body.date_from || null, to: body.date_to || null });
}
function revisionConflict(expected, current, key = 'appointment') {
    if (!Number.isSafeInteger(Number(expected)) || Number(expected) < 1) {
        return fail(428, 'REVISION_REQUIRED', 'Actualiza la lectura antes de guardar.', { [key]: current });
    }
    return Number(expected) !== Number(current.revision)
        ? fail(409, 'REVISION_CONFLICT', 'Otra persona modifico estos datos. Revisa la version vigente antes de continuar.', { [key]: current }) : null;
}
async function audit(before, after, body, operation, transaction, cancellationCode) {
    // Store scheduling changes and changed field names, never clinical text or contact details.
    const changes = {};
    for (const k of Object.keys(fields)) if (!before || !same(before, after, [k])) {
        changes[k] = ['status', 'doctorProfileId', 'date', 'startTime', 'endTime', 'rescheduledFromAppointmentId', 'rescheduledToAppointmentId'].includes(k)
            ? { from: before ? before[k] || null : null, to: after[k] || null } : { changed: true };
    }
    if (cancellationCode) changes.cancellationReasonCode = { to: cancellationCode };
    await query(`INSERT INTO appointment_audit(id_business,appointment_id,actor_id,operation,revision,changes)
        VALUES(:business,:id,:actor,:operation,:revision,:changes)`, { business: body.id_business, id: after.id,
        actor: body.id_login, operation, revision: after.revision, changes: JSON.stringify(changes) }, transaction, QueryTypes.INSERT);
}
async function persist(a, current, body, operation, transaction, cancellationCode) {
    const values = Object.fromEntries(Object.keys(fields).map(k => [k, a[k] || null]));
    Object.assign(values, { business: body.id_business, actor: body.id_login, id: current ? current.id : randomUUID(),
        blocks: Number(blocking(a.status)) });
    if (current) {
        await query(`UPDATE appointment SET ${Object.entries(fields).map(([key, col]) => `${col}=:${key}`).join(',')},
            blocks_availability=:blocks,revision=revision+1,updated_at=NOW(),updated_by=:actor
            WHERE id_appointment=:id AND id_business=:business AND active=1`, values, transaction, QueryTypes.UPDATE);
    } else {
        await query(`INSERT INTO appointment(id_appointment,id_business,${Object.values(fields).join(',')},blocks_availability,created_by)
            VALUES(:id,:business,${Object.keys(fields).map(k => ':' + k).join(',')},:blocks,:actor)`, values, transaction, QueryTypes.INSERT);
    }
    const saved = await get(values.id, body.id_business, transaction);
    await audit(current, saved, body, operation, transaction, cancellationCode);
    return saved;
}
async function write(dao, body, operation = 'save') {
    let transaction;
    try {
        const incoming = dao.normalizeAppointmentPayload(body.appointment || body);
        const requestId = body.request_id || incoming.requestId;
        if (requestId && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId))) return fail(400, 'INVALID_REQUEST_ID', 'Identificador de operacion invalido.');
        if ((!incoming.id || operation === 'reschedule') && !requestId) return fail(428, 'REQUEST_ID_REQUIRED', 'Actualiza la aplicacion antes de agendar.');
        const dto = Object.fromEntries(['id', 'revision', ...Object.keys(fields)].map(k => [k, incoming[k] || null]));
        // Preserve the exact legacy hash when the new field is absent.
        if (Object.prototype.hasOwnProperty.call(incoming, 'cancellationReasonCode')) dto.cancellationReasonCode = incoming.cancellationReasonCode;
        const hash = createHash('sha256').update(JSON.stringify({ dto, sync: body.sync_follow_up === true, explicitNew: body.explicit_new_follow_up === true })).digest('hex');
        transaction = await db.transaction();
        // One tenant lock serializes booking, configuration and retries, including distinct sessions.
        await query('SELECT id_business FROM business WHERE id_business=:business FOR UPDATE', { business: body.id_business }, transaction);
        if (requestId) {
            const [receipt] = await query('SELECT actor_id,operation,payload_hash,appointment_id FROM appointment_write_request WHERE id_business=:business AND request_id=:requestId', { business: body.id_business, requestId }, transaction);
            if (receipt) {
                if (receipt.actor_id !== body.id_login || receipt.operation !== operation || receipt.payload_hash !== hash) {
                    await transaction.rollback(); return fail(409, 'REQUEST_REUSED', 'Esta operacion ya se envio con otros datos. Inicia otra operacion para cambiarlos.');
                }
                const saved = await get(receipt.appointment_id, body.id_business, transaction);
                await transaction.rollback(); return { status: 200, data: [saved], message: 'Operacion ya guardada. No se duplico.' };
            }
        }
        const current = incoming.id ? await get(incoming.id, body.id_business, transaction) : null;
        const reject = async result => { await transaction.rollback(); return result; };
        if (incoming.id && !current) return reject(fail(403, 'APPOINTMENT_UNAVAILABLE', 'Cita no disponible para este consultorio.'));
        if (current) {
            const conflict = revisionConflict(incoming.revision, current);
            if (conflict) return reject(conflict);
            if (current.status === 'rescheduled') return reject(fail(409, 'APPOINTMENT_REPLACED', 'Esta cita ya fue reprogramada. Abre la cita destino.', { appointment: current }));
            if (!same(current, incoming, ['patientId', 'followUpId'])) return reject(fail(400, 'IMMUTABLE_LINK', 'El paciente y seguimiento de una cita guardada no se pueden sustituir.'));
        }
        if (operation === 'reschedule' && (!current || !blocking(current.status))) return reject(fail(409, 'RESCHEDULE_STATE', 'Solo se puede reprogramar una cita vigente.'));
        if (operation === 'save' && (incoming.status === 'rescheduled' || !same(incoming, current || {}, ['rescheduledFromAppointmentId', 'rescheduledToAppointmentId']))) {
            return reject(fail(400, 'RESCHEDULE_REQUIRED', 'Usa la accion Reprogramar para vincular las citas.'));
        }
        let a = { ...incoming, source: current ? current.source : incoming.source || 'manual' };
        if (operation === 'reschedule') {
            a = { ...a, id: null, status: 'pending_confirmation', rescheduledFromAppointmentId: current.id, rescheduledToAppointmentId: null, cancellationReason: null };
        }
        const now = Date.now();
        const closeOnly = current && operation === 'save' && closing(a.status)
            && (current.status !== a.status || same(a, current, scheduleKeys));
        if (closeOnly) {
            if (!same(a, current, scheduleKeys)) return reject(fail(400, 'CLOSE_ONLY', 'Para cerrar una cita conserva su doctor, fecha y horario.'));
            // Closing an old booking does not reactivate or modify an archived patient/doctor.
            a = { ...current, status: a.status, title: a.title, description: a.description, cancellationReason: a.cancellationReason || null,
                ...(Object.prototype.hasOwnProperty.call(a, 'cancellationReasonCode') ? { cancellationReasonCode: a.cancellationReasonCode } : {}) };
        } else {
            const resolved = await resolveProfessional(body, a.doctorProfileId, transaction);
            if (resolved.error) return reject(resolved.error);
            a.doctorProfileId = resolved.doctor.id_doctor_professional_profile;
            a.doctorName = resolved.doctor.professional_name;
            const invalidPayload = await dao.validateAppointmentPayload(a, body.id_business, transaction);
            if (invalidPayload) return reject(invalidPayload);
        }
        if (String(a.cancellationReason || '').length > 1000 || String(a.source || '').length > 50) return reject(fail(400, 'INVALID_LENGTH', 'Revisa la longitud del motivo de cancelacion o del origen.'));
        const invalidShape = validateAppointment({ ...a, status: 'cancelled' }, null);
        if (invalidShape) return reject(fail(400, 'INVALID_APPOINTMENT', invalidShape));
        if (!['pending_confirmation', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(a.status)) return reject(fail(400, 'INVALID_STATUS', 'Estado de cita invalido.'));
        if (String(a.title || '').length > 500 || String(a.description || '').length > 5000) return reject(fail(400, 'INVALID_LENGTH', 'Revisa la longitud de los datos de la cita.'));
        // Association rules apply even when a caller omits sync_follow_up.
        const reopensHistory = current && current.status !== a.status
            && !['pending_confirmation', 'confirmed'].includes(current.status) && blocking(a.status);
        const newAssociation = a.followUpId && (!current || operation === 'reschedule' || reopensHistory);
        if (newAssociation && current && operation === 'save') return reject(fail(409, 'FOLLOW_UP_APPOINTMENT_TERMINAL', 'Conserva la cita historica y agenda una nueva atencion de forma explicita.'));
        if (newAssociation) {
            if (!current && !await hasPermission(body.id_login, 'px.tab.monitoring', { transaction })) return reject(fail(403, 'FOLLOW_UP_PERMISSION_REQUIRED', 'No tienes permiso para asociar seguimientos.'));
            const response = await dao.validateFollowUpSync({ ...a, id: null }, { ...body, explicit_new_follow_up: operation === 'reschedule' || body.explicit_new_follow_up === true }, transaction, { excludeId: current && current.id, associationOnly: body.sync_follow_up !== true });
            if (response && response.status === 200 && requestId) {
                await query(`INSERT INTO appointment_write_request(id_business,request_id,actor_id,operation,payload_hash,appointment_id)
                    VALUES(:business,:requestId,:actor,:operation,:hash,:id)`, { business: body.id_business, requestId, actor: body.id_login, operation, hash, id: response.data[0].id }, transaction, QueryTypes.INSERT);
                await transaction.commit(); return response;
            }
            if (response) return reject(response);
        }
        // Existing closing/status-only operations must not inherit clinical synchronization.
        if (!newAssociation && body.sync_follow_up === true && !closing(a.status)) {
            const response = await dao.validateFollowUpSync(a, body, transaction);
            if (response) return reject(response);
        }
        if (policy.needsClock(a, operation === 'reschedule' ? null : current)) {
            const general = await dao.readConfig(body.id_business, null, transaction);
            const invalidTime = policy.temporal(a, operation === 'reschedule' ? null : current, general && general.timezone, now);
            if (invalidTime) return reject(invalidTime);
        }
        const cancellation = policy.cancellation(a, current);
        if (cancellation.error) return reject(cancellation.error);
        a = cancellation.appointment;
        // Existing bookings remain manageable after schedule closure; moving/reopening needs availability.
        const retainsBooking = current && blocking(current.status) && same(a, current, scheduleKeys) && operation === 'save';
        if (!closeOnly && !retainsBooking) {
            const config = await dao.readConfig(body.id_business, a.doctorProfileId, transaction);
            const general = await dao.readConfig(body.id_business, null, transaction);
            Object.assign(config, { businessEnabled: !!general.enabled, businessBlockedDates: general.blockedDates || [], businessBlockedHours: general.blockedHours || [] });
            const invalid = validateAppointment(a, config);
            if (invalid) return reject(fail(400, 'UNAVAILABLE_SLOT', invalid));
        }
        // Exclude only the verified origin. No second request can observe this intermediate state.
        if (operation === 'reschedule') await query("UPDATE appointment SET status='rescheduled',blocks_availability=0 WHERE id_appointment=:id AND id_business=:business", { id: current.id, business: body.id_business }, transaction, QueryTypes.UPDATE);
        const conflict = await dao.validateAvailabilityConflict(a, body.id_business, transaction);
        if (conflict) return reject(conflict);
        const impact = current && current.status !== 'cancelled' && a.status === 'cancelled'
            ? await cancellationImpact.evaluate(dao, current, body, transaction, now) : null;
        const saved = await persist(a, operation === 'reschedule' ? null : current, body, operation, transaction, cancellation.code);
        if (operation === 'reschedule') await persist({ ...current, status: 'rescheduled', rescheduledToAppointmentId: saved.id }, current, body, operation, transaction);
        if (requestId) await query(`INSERT INTO appointment_write_request(id_business,request_id,actor_id,operation,payload_hash,appointment_id)
            VALUES(:business,:requestId,:actor,:operation,:hash,:id)`, { business: body.id_business, requestId, actor: body.id_login, operation, hash, id: saved.id }, transaction, QueryTypes.INSERT);
        await transaction.commit();
        return { status: 200, data: [saved], message: 'Cita guardada.', ...(impact ? { cancellationImpact: {
            ...impact, changedSincePreview: Boolean(incoming.cancellationImpactToken && incoming.cancellationImpactToken !== impact.token)
        } } : {}) };
    } catch (error) {
        if (transaction && !transaction.finished) await transaction.rollback();
        return fail(500, 'APPOINTMENT_WRITE_UNCONFIRMED', 'No se pudo confirmar el guardado. Conserva la captura y reintenta la misma operacion.');
    }
}
module.exports = { write, list, get, revisionConflict, query };

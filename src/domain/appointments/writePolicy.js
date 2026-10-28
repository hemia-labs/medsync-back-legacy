'use strict';
const clock = require('../pulse/time');
const fail = (code, message) => ({ status: 400, data: { code }, message });
const reasons = Object.freeze({ patient_cancelled: 'El paciente canceló', doctor_unavailable: 'Doctor no disponible',
    entry_error: 'Error de captura', reschedule_pending: 'El paciente solicita reagendar sin fecha', other: 'Otro' });
const changed = (a, b, keys) => !b || keys.some(key => String(a[key] || '') !== String(b[key] || ''));

function needsClock(a, current) {
    return !current || ((a.status !== 'cancelled' || current.status === 'cancelled') && (changed(a, current, ['date', 'startTime', 'endTime'])
        || (a.status !== current.status && ['completed', 'no_show'].includes(a.status))));
}
function temporal(a, current, zone, now) {
    if (!needsClock(a, current)) return null;
    if (clock.timeZone(zone).source !== 'configured') return fail('INVALID_CLINIC_TIMEZONE', 'Revisa la zona horaria del consultorio antes de cambiar el horario o cerrar la cita.');
    const start = clock.wall(a.date, a.startTime, zone), end = clock.wall(a.date, a.endTime, zone);
    if (start === null || end === null || end <= start) return fail('INVALID_LOCAL_TIME', 'El horario no existe o es ambiguo en la zona del consultorio. Selecciona otro horario.');
    if (start > now && ((!current && !['pending_confirmation', 'confirmed'].includes(a.status))
        || ['completed', 'no_show'].includes(a.status))) {
        return fail('APPOINTMENT_NOT_STARTED', 'La cita aún no inicia en la zona horaria del consultorio. Conserva Pendiente o Confirmada.');
    }
    return null;
}
function cancellation(a, current) {
    if (a.status !== 'cancelled') return { appointment: a };
    const suppliedCode = Object.prototype.hasOwnProperty.call(a, 'cancellationReasonCode');
    if (current && current.status === 'cancelled' && !suppliedCode && !changed(a, current, ['cancellationReason'])) return { appointment: a };
    if (a.cancellationReason != null && typeof a.cancellationReason !== 'string') return { error: fail('INVALID_CANCELLATION_REASON', 'Escribe un motivo de cancelación válido.') };
    const detail = String(a.cancellationReason || '').trim();
    const code = suppliedCode ? a.cancellationReasonCode : 'other';
    if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(reasons, code)) return { error: fail('INVALID_CANCELLATION_REASON', 'Selecciona un motivo de cancelación válido.') };
    if (code === 'other' && !detail) return { error: fail('CANCELLATION_REASON_REQUIRED', 'Escribe el motivo de cancelación.') };
    const summary = !suppliedCode || code === 'other' ? detail : reasons[code] + (detail ? ': ' + detail : '');
    if (summary.length > 1000) return { error: fail('INVALID_CANCELLATION_REASON', 'El motivo de cancelación debe tener como máximo 1000 caracteres.') };
    return { appointment: { ...a, cancellationReason: summary }, code };
}
module.exports = { temporal, needsClock, cancellation, reasons };

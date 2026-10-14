const STATUSES = ['pending_confirmation', 'confirmed', 'completed', 'cancelled', 'rescheduled', 'no_show'];
const bool = v => v === true || v === 1 || v === '1';
const minute = v => { const p = String(v || '').split(':').map(Number); return p[0] * 60 + p[1]; };
const time = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const date = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
const overlaps = (a, b, c, d) => minute(a) < minute(d) && minute(b) > minute(c);
const matchesDate = (b, value) => bool(b.repeats) && b.repeatType === 'weekly'
    ? Number(b.dayOfWeek) === new Date(`${value}T12:00:00Z`).getUTCDay() : b.date === value;

function validateConfig(c) {
    if (c && (!Array.isArray(c.blockedDates || []) || !Array.isArray(c.blockedHours || []))) return 'Lista de bloqueos invalida.';
    if (!c || !Array.isArray(c.workingDays) || c.workingDays.length !== 7) return 'Configura los siete dias de la semana.';
    const duration = Number(c.defaultAppointmentDuration);
    if (!Number.isInteger(duration) || duration < 5 || duration > 240) return 'La duracion debe ser de 5 a 240 minutos.';
    try { new Intl.DateTimeFormat('es-MX', { timeZone: c.timezone }).format(); } catch (_) { return 'Zona horaria invalida.'; }
    const days = new Set();
    for (const d of c.workingDays) {
        if (!Number.isInteger(Number(d.dayOfWeek)) || Number(d.dayOfWeek) < 0 || Number(d.dayOfWeek) > 6 || days.has(Number(d.dayOfWeek))) return 'Dias de la semana invalidos o repetidos.';
        days.add(Number(d.dayOfWeek));
        if (!Array.isArray(d.timeRanges)) return 'Rangos de horario invalidos.';
        for (const r of d.timeRanges) if (!time(r.startTime) || !time(r.endTime) || minute(r.startTime) >= minute(r.endTime)) return 'Revisa el inicio y fin de los horarios.';
        for (let i = 0; i < d.timeRanges.length; i++) for (let j = i + 1; j < d.timeRanges.length; j++) {
            const a = d.timeRanges[i], b = d.timeRanges[j];
            if (overlaps(a.startTime, a.endTime, b.startTime, b.endTime)) return 'Los rangos de un dia no pueden solaparse.';
        }
        if (bool(d.enabled) && !d.timeRanges.length) return 'Un dia activo necesita al menos un horario.';
    }
    for (const b of [...(c.blockedDates || []), ...(c.blockedHours || [])]) {
        if (bool(b.repeats)) {
            if (b.repeatType !== 'weekly' || b.dayOfWeek === null || b.dayOfWeek === '' || !Number.isInteger(Number(b.dayOfWeek)) || Number(b.dayOfWeek) < 0 || Number(b.dayOfWeek) > 6) return 'Repeticion del bloqueo invalida.';
        } else if (!date(b.date)) return 'Fecha del bloqueo invalida.';
    }
    for (const b of c.blockedHours || []) if (!time(b.startTime) || !time(b.endTime) || minute(b.startTime) >= minute(b.endTime)) return 'Horario del bloqueo invalido.';
    return '';
}

function validateAppointment(a, c) {
    if (!date(a.date) || !time(a.startTime) || !time(a.endTime) || minute(a.startTime) >= minute(a.endTime)) return 'Fecha u horario de cita invalido.';
    if (!STATUSES.includes(a.status)) return 'Estado de cita invalido.';
    if (!['pending_confirmation', 'confirmed', 'completed'].includes(a.status)) return '';
    if (!c || !bool(c.enabled) || c.businessEnabled === false) return 'La agenda del doctor no esta activa.';
    const day = (c.workingDays || []).find(d => Number(d.dayOfWeek) === new Date(`${a.date}T12:00:00Z`).getUTCDay());
    if (!day || !bool(day.enabled) || !(day.timeRanges || []).some(r => minute(a.startTime) >= minute(r.startTime) && minute(a.endTime) <= minute(r.endTime) && (minute(a.startTime) - minute(r.startTime)) % Number(c.defaultAppointmentDuration) === 0)) return 'El horario seleccionado esta fuera de la agenda del doctor.';
    if ([...(c.blockedDates || []), ...(c.businessBlockedDates || [])].some(b => matchesDate(b, a.date))) return 'La fecha esta bloqueada.';
    if ([...(c.blockedHours || []), ...(c.businessBlockedHours || [])].some(b => matchesDate(b, a.date) && overlaps(a.startTime, a.endTime, b.startTime, b.endTime))) return 'El horario esta bloqueado.';
    return '';
}
module.exports = { validateConfig, validateAppointment, STATUSES };

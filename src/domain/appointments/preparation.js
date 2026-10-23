'use strict';
const { validateConfig } = require('./agendaRules');
const enabled = value => value === true || value === 1 || value === '1';
const minutes = value => { const [h, m] = String(value).split(':').map(Number); return h * 60 + m; };

// Diagnostic projection only. Reservation/CO21 rules remain the authority for each interval.
function evaluateAgenda({ subject = null, profileActive = false, individual = null, business = null, capabilities = {} }) {
    const timezone = business && business.timezone;
    let zoneValid = typeof timezone === 'string' && !!timezone.trim();
    try { if (zoneValid) new Intl.DateTimeFormat('es-MX', { timeZone: timezone }).format(); } catch (_) { zoneValid = false; }
    const duration = Number(individual && individual.defaultAppointmentDuration);
    const durationValid = !!individual && Number.isInteger(duration) && duration >= 5 && duration <= 240;
    // Validate each structural dimension with the existing validator, without repairing stored days.
    const hoursError = individual ? validateConfig({ ...individual, defaultAppointmentDuration:30, timezone:'UTC', blockedDates:[], blockedHours:[] }) : '';
    const hoursValid = !!individual && !hoursError;
    const hasUsualSlot = hoursValid && durationValid && individual.workingDays.some(day => enabled(day.enabled) && day.timeRanges.some(range => minutes(range.endTime) - minutes(range.startTime) >= duration));
    const structure = !!individual && !!business && durationValid && hoursValid && zoneValid;
    const activation = { individual:!!individual && enabled(individual.enabled), business:!!business && enabled(business.enabled) };
    const requirements = { profile:!!profileActive, timezone:zoneValid, duration:durationValid, hours:hoursValid };
    const issues = [];
    const issue = (code, field, message) => issues.push({code, field, message});
    if (!business) issue('BUSINESS_CONFIG_ABSENT','timezone','Falta la configuración general del consultorio. Pide al administrador que prepare la zona horaria y disponibilidad del consultorio.');
    else if (!zoneValid) issue('TIMEZONE_INVALID','timezone','La zona horaria del consultorio no es válida. Revísala antes de organizar citas.');
    if (individual && !durationValid) issue('DURATION_INVALID','duration','Elige una duración habitual de 5 a 240 minutos y guarda la agenda.');
    if (individual && !hoursValid) {
        const storedDays = new Set((individual.workingDays || []).map(day => Number(day.dayOfWeek)));
        const missing = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'].filter((_, day) => !storedDays.has(day));
        issue(missing.length ? 'MISSING_DAYS' : 'HOURS_INVALID','hours',missing.length
            ? `Falta guardar ${missing.join(', ')} en esta agenda. La pantalla muestra los días faltantes como inactivos. Revisa los siete días y pulsa Guardar cambios, aunque no modifiques los horarios.`
            : `${hoursError} Revisa los horarios semanales y pulsa Guardar cambios.`);
    }
    const reasons = [];
    if (!profileActive) reasons.push('PROFILE_INACTIVE');
    if (!individual) reasons.push('CONFIG_ABSENT');
    if (!business) reasons.push('BUSINESS_CONFIG_ABSENT');
    if (!zoneValid) reasons.push('TIMEZONE_INVALID');
    if (individual && !durationValid) reasons.push('DURATION_INVALID');
    if (individual && !hoursValid) reasons.push('HOURS_INVALID');
    if (structure && !hasUsualSlot) reasons.push('NO_USUAL_SLOT');
    if (individual && !activation.individual) reasons.push('DOCTOR_INACTIVE');
    if (business && !activation.business) reasons.push('BUSINESS_INACTIVE');
    if (!capabilities.book) reasons.push('BOOKING_FORBIDDEN');
    return {
        statusVersion:1, subject, configurationState:!individual ? 'absent' : structure ? 'valid' : 'incomplete',
        requirements, activation, capabilities, reasons, issues,
        canBookDefaultDuration:!!(profileActive && structure && hasUsualSlot && activation.individual && activation.business && capabilities.book),
        hasUsualSlot:!!hasUsualSlot,
        versions:{doctorConfigRevision:individual ? Number(individual.revision) : null, businessConfigRevision:business ? Number(business.revision) : null},
        evaluatedAt:new Date().toISOString()
    };
}

// A single SELECT supplies one consistent snapshot. Keep duplicate/missing days visible to validation.
function fromRows(records, capabilities) {
    const first = records[0];
    const days = new Map();
    for (const row of records) {
        if (!row.day_id) continue;
        if (!days.has(row.day_id)) days.set(row.day_id, {dayOfWeek:row.day_of_week, enabled:row.day_enabled, timeRanges:[]});
        if (row.range_id) days.get(row.day_id).timeRanges.push({startTime:row.start_time, endTime:row.end_time});
    }
    return evaluateAgenda({
        subject:first.profile_id || null, profileActive:enabled(first.profile_active) && enabled(first.user_active), capabilities,
        individual:first.config_id ? {enabled:first.enabled, revision:first.revision, defaultAppointmentDuration:first.duration, workingDays:[...days.values()]} : null,
        business:first.business_config_id ? {enabled:first.business_enabled, revision:first.business_revision, timezone:first.timezone} : null
    });
}
module.exports = { evaluateAgenda, fromRows };

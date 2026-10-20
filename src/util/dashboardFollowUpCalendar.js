const DEFAULT_TIME_ZONE = 'America/Mexico_City';

function followUpCalendar(timeZone, now = new Date()) {
    let effectiveZone = String(timeZone || DEFAULT_TIME_ZONE).trim();
    let formatter;
    const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
    try {
        formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: effectiveZone });
    } catch (_) {
        effectiveZone = DEFAULT_TIME_ZONE;
        formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: effectiveZone });
    }
    const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
    return { asOfDate: `${parts.year}-${parts.month}-${parts.day}`, timeZone: effectiveZone };
}

module.exports = { followUpCalendar, DEFAULT_TIME_ZONE };

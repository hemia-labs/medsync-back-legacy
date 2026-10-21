'use strict';
const DAY = 86400000, formatters = new Map();
function formatter(zone) {
    if (!formatters.has(zone)) { if (formatters.size >= 64) formatters.delete(formatters.keys().next().value); formatters.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })); }
    return formatters.get(zone);
}
function parts(at, zone) { return Object.fromEntries(formatter(zone).formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)])); }
function timeZone(value) { try { if (!value || typeof value !== 'string') throw Error(); formatter(value).format(0); return { name: value, source: 'configured' }; } catch (_) { return { name: 'America/Mexico_City', source: 'fallback' }; } }
function date(at, zone) { const p = parts(at, zone); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; }
function wall(dateValue, time, zone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue || '') || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time || '')) return null;
    const [y, m, d] = dateValue.split('-').map(Number), [h, mi, s = 0] = time.split(':').map(Number), guess = Date.UTC(y, m - 1, d, h, mi, s), offsets = new Set();
    if (new Date(guess).toISOString().slice(0, 10) !== dateValue) return null;
    for (const delta of [-36, -12, 0, 12, 36]) { const at = guess + delta * 3600000, p = parts(at, zone); offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at); }
    const matches = [...offsets].map(o => guess - o).filter(at => { const p = parts(at, zone); return p.year === y && p.month === m && p.day === d && p.hour === h && p.minute === mi && p.second === s; });
    return matches.length === 1 ? matches[0] : null;
}
const sqlTime = at => new Date(at).toISOString().slice(0, 23).replace('T', ' ');
const instant = value => value === null || value === undefined ? null : value instanceof Date ? value.getTime() : Date.parse(String(value).replace(' ', 'T').replace(/(?<!Z)$/, 'Z'));
function nextMidnight(at, zone) { const today = date(at, zone), next = new Date(Date.parse(today + 'T00:00:00Z') + DAY).toISOString().slice(0, 10); return wall(next, '00:00:00', zone); }
module.exports = { DAY, parts, timeZone, date, wall, sqlTime, instant, nextMidnight };

'use strict';
// NC5 · Chat interno. Reglas puras: sin base de datos ni sesión, para probarlas aisladas.
const crypto = require('node:crypto');

const BODY_MAX = 2000;
const COMMENT_MAX = 500;
const FREQUENT_LIMIT = 2;
const REASONS = Object.freeze({
    control: 'Control',
    tratamiento: 'Tratamiento',
    revision: 'Revisión',
    otro: 'Otro'
});
// Permisos que ya permiten ver datos de pacientes. Se evalúan al leer, con los permisos vigentes del lector.
const PATIENT_DATA_PERMISSIONS = Object.freeze(['px.dates', 'px.all', 'px.tab.monitoring']);
const AGENDA_PERMISSIONS = Object.freeze(['px.dates', 'admin.config']);
// Referencias que Notas puede entregar: nota formal firmada (NC5) o seguimiento operativo existente.
const CONTEXT_KINDS = Object.freeze(['evolution_note', 'tracing']);
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const LOGIN_ID = /^[^\s]{1,50}$/;

function text(value, max, { required = true } = {}) {
    if (value === undefined || value === null || value === '') return required ? null : '';
    if (typeof value !== 'string' || !value.isWellFormed()) return null;
    const trimmed = value.replace(/\r\n?/g, '\n').trim();
    if (!trimmed) return required ? null : '';
    return [...trimmed].length <= max ? trimmed : null;
}

const body = value => text(value, BODY_MAX);
const comment = value => text(value, COMMENT_MAX, { required: false });
const requestId = value => (typeof value === 'string' && REQUEST_ID.test(value) ? value : null);
const loginId = value => (typeof value === 'string' && LOGIN_ID.test(value) ? value : null);
const reason = value => (typeof value === 'string' && Object.hasOwn(REASONS, value) ? value : null);

function pair(a, b) {
    return a < b ? { low: a, high: b } : { low: b, high: a };
}

function initials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    const letters = (words.length > 1 ? [words[0], words[words.length - 1]] : words).map(word => [...word][0].toLocaleUpperCase('es'));
    return letters.join('') || '?';
}

// Iniciales con punto para el paciente cuando el lector no tiene permisos de datos de pacientes.
function patientInitials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    return words.length ? words.map(word => [...word][0].toLocaleUpperCase('es') + '.').join(' ') : 'Paciente';
}

const byName = (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Hasta dos frecuentes por mensajes enviados en este negocio; empate por envío más reciente, nombre e id.
// El resto, por nombre. Cada persona aparece una sola vez.
function orderDirectory(people, activity = []) {
    const stats = new Map(activity.map(row => [row.id, { count: Number(row.count) || 0, last: row.last ? new Date(row.last).getTime() : 0 }]));
    const unique = [...new Map(people.map(person => [person.id, person])).values()];
    const frequent = unique
        .filter(person => (stats.get(person.id)?.count || 0) > 0)
        .sort((a, b) => {
            const sa = stats.get(a.id), sb = stats.get(b.id);
            return sb.count - sa.count || sb.last - sa.last || byName(a, b);
        })
        .slice(0, FREQUENT_LIMIT);
    const chosen = new Set(frequent.map(person => person.id));
    const rest = unique.filter(person => !chosen.has(person.id)).sort(byName);
    return [
        ...frequent.map(person => ({ ...person, frequent: true })),
        ...rest.map(person => ({ ...person, frequent: false }))
    ];
}

function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Datos operativos tal como los verá un lector concreto. Nunca incluye nota, diagnóstico ni tratamientos.
function noticeView(row, viewer) {
    const canSeePatient = viewer.isSender || viewer.permissions.some(code => PATIENT_DATA_PERMISSIONS.includes(code));
    const canCoordinate = viewer.permissions.some(code => AGENDA_PERMISSIONS.includes(code));
    return {
        patient: canSeePatient
            ? { name: row.snap_patient_name || 'Paciente', code: row.snap_patient_code || null, restricted: false }
            : { name: patientInitials(row.snap_patient_name), code: null, restricted: true },
        professional: row.snap_professional_name || null,
        reason: { code: row.reason_code, label: REASONS[row.reason_code] || 'Otro' },
        attentionDate: row.snap_attention_date ? String(row.snap_attention_date).slice(0, 10) : null,
        reference: canSeePatient ? row.context_ref : null,
        canCoordinate
    };
}

function preview(row) {
    if (row.kind === 'team_notice') return 'Aviso de seguimiento' + (row.reason_code ? ' · ' + (REASONS[row.reason_code] || 'Otro') : '');
    const value = String(row.body || '').replace(/\s+/g, ' ').trim();
    return [...value].length > 80 ? [...value].slice(0, 79).join('') + '…' : value;
}

module.exports = {
    BODY_MAX, COMMENT_MAX, FREQUENT_LIMIT, REASONS, CONTEXT_KINDS, PATIENT_DATA_PERMISSIONS, AGENDA_PERMISSIONS,
    body, comment, requestId, loginId, reason, pair, initials, patientInitials, orderDirectory, hash, noticeView, preview
};

'use strict';
// NC4/L2: validación de un código DIAGNOSTICO_SIS en su posición y perfil (R04). Funciones puras.
const { getProfile } = require('./index');
const { validDate } = require('../sisCatalog/release');

// LINF/LSUP: tres dígitos y clave de edad (H horas, D días, M meses, A años); "NO" = sin límite.
function parseAgeLimit(raw) {
    const value = String(raw || '').trim().toUpperCase();
    if (value === 'NO' || value === '') return null;
    const m = value.match(/^(\d{3})([HDMA])$/);
    if (!m) throw Object.assign(new Error('Límite de edad no reconocido: ' + raw), { code: 'DIAGNOSIS_AGE_LIMIT_FORMAT' });
    return { amount: Number(m[1]), unit: m[2] };
}

// La hoja de descripción dice 1 = HOMBRE, 2 = MUJER; el archivo 2024-04 usa el texto. Se aceptan ambos de forma explícita.
function parseSexLimit(raw) {
    const value = String(raw || '').trim().toUpperCase();
    if (value === 'NO' || value === '') return null;
    if (value === 'HOMBRE' || value === '1') return '1';
    if (value === 'MUJER' || value === '2') return '2';
    throw Object.assign(new Error('LSEX no reconocido: ' + raw), { code: 'DIAGNOSIS_SEX_LIMIT_FORMAT' });
}

const parsePersonnelList = raw => {
    const value = String(raw || '').trim().toUpperCase();
    return value === 'NO' || value === '' ? [] : value.split(',').map(v => v.trim()).filter(Boolean);
};

/**
 * Edad cumplida entre dos fechas civiles YYYY-MM-DD, sin redondear (meses y días incluidos).
 * L2-R5: exige fechas civiles reales y nacimiento no posterior a la fecha clínica.
 * Con solo fechas civiles las horas no se conocen: se da el intervalo posible [días×24, días×24+23].
 */
function ageAt(birthDate, clinicalDate) {
    if (!validDate(birthDate)) throw Object.assign(new Error('Fecha de nacimiento inválida: ' + birthDate), { code: 'AGE_DATE_INVALID' });
    if (!validDate(clinicalDate)) throw Object.assign(new Error('Fecha clínica inválida: ' + clinicalDate), { code: 'AGE_DATE_INVALID' });
    if (birthDate > clinicalDate) throw Object.assign(new Error('La fecha clínica es anterior al nacimiento.'), { code: 'AGE_NEGATIVE' });
    const [by, bm, bd] = birthDate.split('-').map(Number);
    const [cy, cm, cd] = clinicalDate.split('-').map(Number);
    let months = (cy - by) * 12 + (cm - bm);
    if (cd < bd) months--;
    const days = Math.round((Date.UTC(cy, cm - 1, cd) - Date.UTC(by, bm - 1, bd)) / 86400000);
    return { years: Math.floor(months / 12), months, days, hoursMin: days * 24, hoursMax: days * 24 + 23 };
}

/** 'ok' | 'violated' | 'undetermined' para un límite inferior o superior. Solo la unidad H puede quedar indeterminada. */
function checkLimit(age, limit, side) {
    if (limit.unit !== 'H') {
        const value = { D: age.days, M: age.months, A: age.years }[limit.unit];
        return (side === 'lower' ? value < limit.amount : value > limit.amount) ? 'violated' : 'ok';
    }
    if (side === 'lower') return age.hoursMax < limit.amount ? 'violated' : age.hoursMin >= limit.amount ? 'ok' : 'undetermined';
    return age.hoursMin > limit.amount ? 'violated' : age.hoursMax <= limit.amount ? 'ok' : 'undetermined';
}

/**
 * @param {string} profileId
 * @param {string} fieldName codigoCIEDiagnostico1|2|3
 * @param {{ code: string, attributes: object }} entry entrada resuelta del release DIAGNOSTICO_SIS
 * @param {{ biologicalSex: '1'|'2'|'3', birthDate: string, clinicalDate: string, personnelType: string, temporalRelation?: '0'|'1', firstTime?: '0'|'1' }} ctx
 */
function validateDiagnosis(profileId, fieldName, entry, ctx) {
    const rule = getProfile(profileId).rules.diagnosis[fieldName];
    if (!rule) throw new Error('Sin regla de diagnóstico para ' + fieldName);
    const a = entry.attributes;
    const issues = [];
    const pending = [];
    if (!['1', '2', '3'].includes(ctx.biologicalSex)) return { result: 'invalid', issues: [{ code: 'DIAGNOSIS_SEX_INVALID' }] };
    let age;
    try { age = ageAt(ctx.birthDate, ctx.clinicalDate); }
    catch (e) { return { result: 'invalid', issues: [{ code: e.code === 'AGE_NEGATIVE' ? 'DIAGNOSIS_BIRTH_AFTER_CLINICAL_DATE' : 'DIAGNOSIS_DATE_INVALID' }] }; }
    const sex = parseSexLimit(a.LSEX);
    // Sexo biológico 3 (intersexual): solo se validan los límites de edad.
    if (sex && ctx.biologicalSex !== '3' && ctx.biologicalSex !== sex) issues.push({ code: 'DIAGNOSIS_SEX_RESTRICTION' });
    for (const [raw, side, violated] of [[a.LINF, 'lower', 'DIAGNOSIS_AGE_BELOW'], [a.LSUP, 'upper', 'DIAGNOSIS_AGE_ABOVE']]) {
        const limit = parseAgeLimit(raw);
        if (!limit) continue;
        const status = checkLimit(age, limit, side);
        if (status === 'violated') issues.push({ code: violated });
        if (status === 'undetermined') pending.push({ code: 'DIAGNOSIS_AGE_HOURS_UNDETERMINED', limit: raw });
    }
    if (rule.personnelColumn) {
        const column = rule.personnelColumn.any || rule.personnelColumn[ctx.temporalRelation];
        if (!column) issues.push({ code: 'DIAGNOSIS_TEMPORAL_RELATION_REQUIRED' });
        else if (!parsePersonnelList(a[column]).includes(ctx.personnelType)) issues.push({ code: 'DIAGNOSIS_PERSONNEL_NOT_ALLOWED', column });
    }
    const letter = rule.letter && rule.letter[String(a.LETRA || '').trim()];
    if (letter) {
        if (letter.forbidden) issues.push({ code: 'DIAGNOSIS_LETTER_FORBIDDEN', letter: a.LETRA });
        if (letter.personnel && !letter.personnel.includes(ctx.personnelType)) issues.push({ code: 'DIAGNOSIS_LETTER_PERSONNEL', letter: a.LETRA });
        if (letter.firstTime !== undefined && ctx.firstTime !== letter.firstTime) issues.push({ code: 'DIAGNOSIS_LETTER_FIRST_TIME', letter: a.LETRA });
    }
    if (issues.length) return { result: 'invalid', issues: [...issues, ...pending] };
    // Un límite en horas que la fecha civil no resuelve nunca se da por válido.
    return pending.length ? { result: 'unverified', issues: pending } : { result: 'valid', issues: [] };
}

module.exports = { parseAgeLimit, parseSexLimit, parsePersonnelList, ageAt, validateDiagnosis };

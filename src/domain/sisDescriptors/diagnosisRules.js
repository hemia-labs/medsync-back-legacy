'use strict';
// NC4/L2: validación de un código DIAGNOSTICO_SIS en su posición y perfil (R04). Funciones puras.
const { getProfile } = require('./index');

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

/** Edad cumplida entre dos fechas civiles YYYY-MM-DD, sin redondear (meses y días incluidos). */
function ageAt(birthDate, clinicalDate) {
    const [by, bm, bd] = birthDate.split('-').map(Number);
    const [cy, cm, cd] = clinicalDate.split('-').map(Number);
    let months = (cy - by) * 12 + (cm - bm);
    if (cd < bd) months--;
    const days = Math.round((Date.UTC(cy, cm - 1, cd) - Date.UTC(by, bm - 1, bd)) / 86400000);
    if (days < 0) throw Object.assign(new Error('La fecha clínica es anterior al nacimiento.'), { code: 'AGE_NEGATIVE' });
    return { years: Math.floor(months / 12), months, days, hours: days * 24 };
}

const ageIn = (age, unit) => ({ H: age.hours, D: age.days, M: age.months, A: age.years })[unit];

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
    const sex = parseSexLimit(a.LSEX);
    // Sexo biológico 3 (intersexual): solo se validan los límites de edad.
    if (sex && ctx.biologicalSex !== '3' && ctx.biologicalSex !== sex) issues.push({ code: 'DIAGNOSIS_SEX_RESTRICTION' });
    const age = ageAt(ctx.birthDate, ctx.clinicalDate);
    const lower = parseAgeLimit(a.LINF), upper = parseAgeLimit(a.LSUP);
    if (lower && ageIn(age, lower.unit) < lower.amount) issues.push({ code: 'DIAGNOSIS_AGE_BELOW' });
    if (upper && ageIn(age, upper.unit) > upper.amount) issues.push({ code: 'DIAGNOSIS_AGE_ABOVE' });
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
    return issues.length ? { result: 'invalid', issues } : { result: 'valid', issues: [] };
}

module.exports = { parseAgeLimit, parseSexLimit, parsePersonnelList, ageAt, validateDiagnosis };

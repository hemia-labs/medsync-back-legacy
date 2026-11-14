'use strict';
// NC4/L2: descriptores por guía. Cada posición conserva tipo, longitud, obligatoriedad y confidencialidad literales.
// Las reglas que difieren entre guías (R03, R04, RC1) se parametrizan por perfil y posición, nunca por unión.
const B015 = require('./profiles/GIIS-B015-05-04.fields.json');
const B016 = require('./profiles/GIIS-B016-05-04.fields.json');

const RULES = Object.freeze({
    'GIIS-B015-05-04': {
        fileType: 'CEX',
        // R03: CE p45–46, hasta 8 estudios 1–8 (8 = prueba de embarazo cuantitativa hGC).
        lists: { estudiosTeleconsulta: { values: ['1', '2', '3', '4', '5', '6', '7', '8'], max: 8, separator: '&', notApplicable: '-1' } },
        // R04: CE p25–29. Diagnóstico 1 por columnas de personal según relacionTemporal; 2 y 3 por LETRA.
        diagnosis: {
            codigoCIEDiagnostico1: { personnelColumn: { 0: 'TIPO_PERSONAL_1VEZ_CE', 1: 'TIPO_PERSONAL_SUBSEC_CE' }, letter: null },
            codigoCIEDiagnostico2: { personnelColumn: null, letter: { MT: { personnel: ['10'] }, CP: { personnel: ['4'] } }, firstTimeField: 'primeraVezDiagnostico2' },
            codigoCIEDiagnostico3: { personnelColumn: null, letter: { MT: { personnel: ['10'] }, CP: { personnel: ['4'] } }, firstTimeField: 'primeraVezDiagnostico3' }
        }
    },
    'GIIS-B016-05-04': {
        fileType: 'CSB',
        lists: { estudiosTeleconsulta: { values: ['1', '2', '3', '4', '5', '6', '7'], max: 7, separator: '&', notApplicable: '-1' } },
        // R04: SB p23–26. Diagnóstico 1 por VALIDO_SB; 2 y 3 prohíben MT y CP exige primera vez = 0.
        diagnosis: {
            codigoCIEDiagnostico1: { personnelColumn: { any: 'VALIDO_SB' }, letter: null },
            codigoCIEDiagnostico2: { personnelColumn: null, letter: { MT: { forbidden: true }, CP: { firstTime: '0' } }, firstTimeField: 'primeraVezDiagnostico2' },
            codigoCIEDiagnostico3: { personnelColumn: null, letter: { MT: { forbidden: true }, CP: { firstTime: '0' } }, firstTimeField: 'primeraVezDiagnostico3' }
        }
    }
});

function validateProfile(doc) {
    const positions = doc.fields.map(f => f.position);
    if (doc.fields.length !== doc.fieldCount) throw new Error(`${doc.profileId}: fieldCount no coincide.`);
    if (positions.some((p, i) => p !== i + 1)) throw new Error(`${doc.profileId}: posiciones no consecutivas.`);
    if (new Set(doc.fields.map(f => f.name)).size !== doc.fields.length) throw new Error(`${doc.profileId}: nombres repetidos.`);
    for (const f of doc.fields) {
        if (!['yes', 'no', 'conditional'].includes(f.required)) throw new Error(`${doc.profileId}/${f.name}: required inválido.`);
        if (typeof f.confidential !== 'boolean') throw new Error(`${doc.profileId}/${f.name}: confidential inválido.`);
    }
    return Object.freeze({ ...doc, fields: Object.freeze(doc.fields.map(f => Object.freeze({ ...f }))), rules: RULES[doc.profileId] });
}

const PROFILES = Object.freeze({ 'GIIS-B015-05-04': validateProfile(B015), 'GIIS-B016-05-04': validateProfile(B016) });

function getProfile(profileId) {
    const p = PROFILES[profileId];
    if (!p) throw Object.assign(new Error('Perfil desconocido: ' + profileId), { code: 'DESCRIPTOR_UNKNOWN' });
    return p;
}
const getField = (profileId, name) => getProfile(profileId).fields.find(f => f.name === name) || null;
const header = profileId => getProfile(profileId).fields.map(f => f.name).join('|');

/** Lista con separador '&' (p. ej. estudiosTeleconsulta): dominio, máximo y duplicados según el perfil. */
function validateList(profileId, name, raw) {
    const rule = getProfile(profileId).rules.lists[name];
    if (!rule) throw new Error('Sin regla de lista para ' + name);
    if (raw === rule.notApplicable) return { result: 'valid', values: [] };
    const values = String(raw).split(rule.separator);
    const issues = [];
    if (values.some(v => !rule.values.includes(v))) issues.push({ code: 'LIST_VALUE_NOT_ALLOWED', message: `Valores permitidos: ${rule.values.join(', ')}.` });
    if (new Set(values).size !== values.length) issues.push({ code: 'LIST_DUPLICATE', message: 'No se repiten valores.' });
    if (values.length > rule.max) issues.push({ code: 'LIST_TOO_LONG', message: `Máximo ${rule.max} valores.` });
    const field = getField(profileId, name);
    if (field.maxLength && String(raw).length > field.maxLength) issues.push({ code: 'FIELD_TOO_LONG', message: `Máximo ${field.maxLength} caracteres.` });
    return issues.length ? { result: 'invalid', issues } : { result: 'valid', values };
}

module.exports = { PROFILES, RULES, getProfile, getField, header, validateList };

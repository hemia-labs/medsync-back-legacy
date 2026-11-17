'use strict';
// NC4/L2: forma de las referencias a catálogo acordada en el contrato NC1 v1 §5.
// CatalogRef validada = { family, releaseId, code }. CatalogCandidate = { family, code } (sin release; nunca "válida").
// Los tres valores son cadenas ASCII exactas: el código conserva ceros iniciales y mayúsculas tal como el catálogo.

const LIMITS = Object.freeze({ family: 48, releaseId: 50, code: 32 });
const FAMILY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CODE_RE = /^[\x21-\x7E]+$/; // ASCII imprimible, sin espacios; coincide con la colación ascii_bin propuesta.

const issue = (code, field, message) => ({ code, field, message });

function checkString(value, field, re, max) {
    if (typeof value !== 'string') return issue('CATALOG_REF_TYPE', field, `${field} debe ser string, no ${value === null ? 'null' : typeof value}.`);
    if (!value.length || value.length > max) return issue('CATALOG_REF_LENGTH', field, `${field} admite de 1 a ${max} caracteres.`);
    if (!re.test(value)) return issue('CATALOG_REF_FORMAT', field, `${field} tiene caracteres no permitidos.`);
    return null;
}

/**
 * Clasifica una referencia recibida. No normaliza: un código "1" y "01" son distintos.
 * @returns {{ kind: 'ref'|'candidate'|'invalid', value?: object, issues: object[] }}
 */
function classifyRef(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { kind: 'invalid', issues: [issue('CATALOG_REF_SHAPE', null, 'La referencia debe ser un objeto.')] };
    }
    const keys = Object.keys(input).sort().join(',');
    const issues = [];
    if (keys !== 'code,family,releaseId' && keys !== 'code,family') {
        issues.push(issue('CATALOG_REF_SHAPE', null, 'Solo se admiten {family, releaseId, code} o la candidata {family, code}.'));
        return { kind: 'invalid', issues };
    }
    for (const [field, re] of [['family', FAMILY_RE], ['code', CODE_RE]]) {
        const problem = checkString(input[field], field, re, LIMITS[field]);
        if (problem) issues.push(problem);
    }
    const hasRelease = Object.prototype.hasOwnProperty.call(input, 'releaseId');
    if (hasRelease) {
        const problem = checkString(input.releaseId, 'releaseId', RELEASE_RE, LIMITS.releaseId);
        if (problem) issues.push(problem);
    }
    if (issues.length) return { kind: 'invalid', issues };
    return hasRelease
        ? { kind: 'ref', value: Object.freeze({ family: input.family, releaseId: input.releaseId, code: input.code }), issues }
        : { kind: 'candidate', value: Object.freeze({ family: input.family, code: input.code }), issues };
}

const refKey = ref => `${ref.family}\u0000${ref.releaseId}\u0000${ref.code}`;

module.exports = { LIMITS, FAMILY_RE, RELEASE_RE, CODE_RE, classifyRef, refKey };

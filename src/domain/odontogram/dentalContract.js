'use strict';

// CO26 data rules only. Clinical compatibility belongs to the versioned catalog.
const SURFACE_ORDER = 'MODVL';
const quadrant = (q, count, descending = false) =>
    Array.from({ length: count }, (_, i) => q * 10 + (descending ? count - i : i + 1));
const PERMANENT = Object.freeze([
    ...quadrant(1, 8, true), ...quadrant(2, 8),
    ...quadrant(3, 8, true), ...quadrant(4, 8)
]);
const PRIMARY = Object.freeze([
    ...quadrant(5, 5, true), ...quadrant(6, 5),
    ...quadrant(7, 5, true), ...quadrant(8, 5)
]);
function sequence(mode) {
    if (mode === 'permanent') return [...PERMANENT];
    if (mode === 'primary') return [...PRIMARY];
    if (mode === 'mixed') return [...PERMANENT, ...PRIMARY];
    throw new RangeError('Dentición inválida.');
}
function toothNumber(value) {
    if (!(typeof value === 'number' || typeof value === 'string') ||
        !/^(?:[1-4][1-8]|[5-8][1-5])$/.test(String(value))) {
        throw new RangeError('Pieza FDI inválida.');
    }
    return Number(value);
}
function normalizeSurfaces(value) {
    if (typeof value !== 'string' || !value || !/^[MODVLPI]+$/i.test(value)) {
        throw new RangeError('Caras inválidas; usa MODVL, P o I.');
    }
    const normalized = value.toUpperCase().replace(/P/g, 'L').replace(/I/g, 'O');
    return [...SURFACE_ORDER].filter(face => normalized.includes(face)).join('');
}
function normalizeLocation(surfaces, surfacePending = false) {
    if (typeof surfacePending !== 'boolean') throw new TypeError('surface_pending debe ser booleano.');
    if (surfaces === null) return { surfaces: null, surface_pending: surfacePending };
    if (surfacePending) throw new RangeError('Una localización pendiente no puede tener caras.');
    return { surfaces: normalizeSurfaces(surfaces), surface_pending: false };
}
function surfaceLabel(face, tooth) {
    const n = toothNumber(tooth);
    if (!SURFACE_ORDER.includes(face) || face.length !== 1) throw new RangeError('Cara inválida.');
    if (face === 'O' && n % 10 <= 3) return 'I';
    if (face === 'L' && [1, 2, 5, 6].includes(Math.floor(n / 10))) return 'P';
    return face;
}
function anatomicalRange(start, end, mode) {
    const first = toothNumber(start), last = toothNumber(end);
    const group = n => Math.floor((Math.floor(n / 10) - 1) / 2);
    if (group(first) !== group(last)) throw new RangeError('El rango cruza arcada o dentición.');
    const order = sequence(mode);
    const a = order.indexOf(first), b = order.indexOf(last);
    if (a < 0 || b < 0) throw new RangeError('Pieza incompatible con la dentición.');
    const selected = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return a <= b ? selected : selected.reverse();
}
module.exports = {
    SURFACE_ORDER, sequence, toothNumber, normalizeSurfaces,
    normalizeLocation, surfaceLabel, anatomicalRange
};

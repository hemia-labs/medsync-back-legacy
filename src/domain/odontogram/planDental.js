'use strict';
const D = require('./operations');
const { toothNumber, normalizeSurfaces } = require('./dentalContract');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sourceKey = (chart, finding, tooth) => D.hash([chart, finding || null, String(tooth)]);
const unionSurfaces = values => { const joined = values.filter(Boolean).join(''); return joined ? normalizeSurfaces(joined) : null; };
function contributions(detail) {
    // Older saved selections have no contribution record. Preserve their faces
    // as an explicit manual baseline rather than guessing which source supplied them.
    const manual = own(detail,'manual_surfaces') ? detail.manual_surfaces : detail.surfaces;
    return { ...detail, manual_surfaces: manual || null };
}
function contentProjection(item) {
    const faces = (item.tooth_details || []).filter(detail => detail.surfaces).map(detail => ({
        tooth_number: String(toothNumber(detail.tooth_number)), surfaces: normalizeSurfaces(detail.surfaces)
    })).sort((a,b) => a.tooth_number.localeCompare(b.tooth_number));
    return faces.length ? { toothDetails: faces } : {};
}
async function mergeDental(previous, body, options) {
    const existing = new Map(previous.map(detail => [String(detail.tooth_number), D.clone(detail)]));
    const rich = own(body, 'tooth_details');
    if (!rich && !own(body, 'teeth')) return { details: previous, changed: false };
    if (rich && (!Array.isArray(body.tooth_details) || body.tooth_details.length > 52)) D.fail('Selecciona hasta 52 detalles dentales.');
    const input = rich ? body.tooth_details : [...new Set(body.teeth.map(String))].map(tooth_number => ({ tooth_number }));
    const normalized = input.map(detail => {
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) D.fail('Detalle dental inválido.');
        let number;
        try { number = String(toothNumber(detail.tooth_number)); } catch (error) { D.fail(error.message); }
        return { ...detail, tooth_number: number };
    });
    const selected = new Set(normalized.map(detail => detail.tooth_number));
    if (selected.size !== normalized.length) D.fail('No repitas una pieza en tooth_details.');
    if (rich && own(body, 'teeth')) {
        const simple = [...new Set(body.teeth.map(tooth => String(toothNumber(tooth))))].sort();
        if (D.canonical(simple) !== D.canonical([...selected].sort())) D.fail('teeth y tooth_details no coinciden.');
    }
    const result = [];
    for (const detail of normalized) {
        const old = existing.get(detail.tooth_number);
        const next = old ? contributions(D.clone(old)) : { tooth_number: detail.tooth_number, surfaces: null, manual_surfaces: null, manual: !Array.isArray(detail.sources) || !detail.sources.length, sources: [] };
        if (own(detail, 'manual_surfaces') || own(detail, 'surfaces') && (!old || detail.surfaces !== old.surfaces)) {
            const value = own(detail,'manual_surfaces') ? detail.manual_surfaces : detail.surfaces;
            try { next.manual_surfaces = value === null ? null : normalizeSurfaces(value); }
            catch (error) { D.fail(error.message); }
        }
        // A redacted/empty source list never clears saved clinical provenance.
        if (own(detail, 'sources') && !Array.isArray(detail.sources)) D.fail('Fuentes dentales inválidas.');
        if (Array.isArray(detail.sources) && detail.sources.length > 100) D.fail('Demasiadas fuentes para una pieza.');
        for (const source of detail.sources || []) {
            if (!source || typeof source !== 'object') D.fail('Fuente inválida.');
            D.validId(source.id_chart);
            if (source.finding_id !== undefined && source.finding_id !== null) {
                if (typeof source.finding_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(source.finding_id)) D.fail('Hallazgo de origen inválido.');
            }
            const key = sourceKey(source.id_chart, source.finding_id, detail.tooth_number);
            const saved = next.sources.find(item => item.source_key === key);
            if (saved && source.revision === saved.revision) {
                continue; // Do not revalidate historical links whose source disappeared.
            }
            if (saved && source.replace_revision !== saved.revision) D.fail('Cambiar una revisión de origen requiere confirmar la revisión anterior explícitamente.', 409);
            if (!options.canReadOdontogram) D.fail('No tienes permiso para incorporar origen del odontograma.', 403);
            if (!Number.isSafeInteger(source.revision) || source.revision < 0) D.fail('Revisión de origen inválida.');
            const verified = await options.resolveSource(source, detail.tooth_number);
            const verifiedSource = { ...verified, source_key: key, id_chart: source.id_chart, finding_id: source.finding_id || null, revision: source.revision };
            if (saved) next.sources.splice(next.sources.indexOf(saved),1,verifiedSource);
            else next.sources.push(verifiedSource);
        }
        if (own(detail, 'remove_sources')) {
            if (!options.canReadOdontogram || !Array.isArray(detail.remove_sources) || detail.remove_sources.some(key => !/^[a-f0-9]{64}$/.test(key))) D.fail('No se permite retirar estas fuentes.', 403);
            next.sources = next.sources.filter(source => !detail.remove_sources.includes(source.source_key));
        }
        if(next.sources.length>100&&next.sources.length>(old?old.sources.length:0))D.fail('La pieza admite hasta 100 fuentes. Las existentes se conservaron sin truncar.');
        if (detail.clear_manual === true) { next.manual = false; next.manual_surfaces = null; }
        if (detail.manual === true) next.manual = true;
        if (next.manual_surfaces) next.manual = true;
        next.surfaces = unionSurfaces([next.manual_surfaces,...next.sources.map(source=>source.context && source.context.surfaces)]);
        next.sources.sort((a,b) => a.source_key.localeCompare(b.source_key));
        if (next.manual || next.sources.length) result.push(next);
    }
    for (const [number, detail] of existing) {
        if (!selected.has(number) && detail.sources.length && !options.canReadOdontogram) D.fail('Esta pieza conserva fuentes restringidas; no puedes retirarlas.', 403);
    }
    result.sort((a,b) => a.tooth_number.localeCompare(b.tooth_number));
    const before = [...existing.values()].map(contributions).sort((a,b) => a.tooth_number.localeCompare(b.tooth_number));
    const changed = D.canonical(result) !== D.canonical(before);
    if (changed && (rich || options.revision > 0) && body.dental_revision !== options.revision) D.fail('La selección dental cambió; recarga el formulario antes de guardarlo.', 409, 'CO26_PLAN_REVISION');
    return { details: changed ? result : previous, changed };
}
module.exports = { mergeDental, sourceKey, contentProjection, unionSurfaces, contributions };

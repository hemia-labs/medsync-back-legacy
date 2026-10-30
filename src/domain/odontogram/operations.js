'use strict';
const { createHash } = require('node:crypto');
const { sequence, toothNumber, normalizeLocation, normalizeSurfaces } = require('./dentalContract');
const CATALOG_VERSION = 'co26-working-1';
const LIMITS=Object.freeze({batch_operations:100,batch_bytes:131072,note_characters:1000,snapshot_bytes:2097152,findings_per_tooth:1000});
// Working catalog: clinical validation P01 remains a release requirement.
const CATALOG = Object.freeze([
    ['car', 'Caries', 'condition', true, 'observed'],
    ['fx', 'Fractura', 'condition', false, 'observed'],
    ['rr', 'Restos radiculares', 'condition', false, 'observed'],
    ['res', 'Resina', 'restoration', true, 'existing'],
    ['a', 'Amalgama', 'restoration', true, 'existing'],
    ['sel', 'Sellador', 'restoration', true, 'existing'],
    ['cor', 'Corona', 'restoration', false, 'existing'],
    ['endo', 'Endodoncia', 'procedure', false, 'existing'],
    ['imp', 'Implante', 'restoration', false, 'existing'],
    ['ext', 'Extracción indicada', 'procedure', false, 'indicated'],
    ['aus', 'Ausente', 'presence', false, 'observed'],
    ['ne', 'No erupcionado', 'presence', false, 'observed']
].map(([code, label, kind, surface, intent]) => Object.freeze({ code, label, kind, surface, intent })));
function fail(message, status = 422, code = 'CO26_INVALID') {
    throw Object.assign(new Error(message), { status, code });
}
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function validId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(value)) fail('Identificador inválido.');
    return value;
}
function emptyChart(mode) {
    const teeth = {};
    sequence(mode).forEach(n => { teeth[n] = { note: '', findings: [], reviewed_revision: null, review_invalidated: false, version: 0 }; });
    return { mode, revision: 0, generation: 1, status: 'active', catalog_version: CATALOG_VERSION, teeth };
}
function validateBatch(batch) {
    if (!batch || !Array.isArray(batch.ops) || !batch.ops.length || batch.ops.length > 100) fail('El lote admite de 1 a 100 operaciones.');
    validId(batch.batch_id);
    if (!Number.isSafeInteger(batch.base_revision) || batch.base_revision < 0 || !Number.isSafeInteger(batch.generation)) fail('Revisión o generación inválida.');
    if (typeof batch.catalog_version !== 'string' || batch.catalog_version.length > 64) fail('Versión de catálogo inválida.');
    if (batch.alias_version !== undefined && !/^[a-f0-9]{64}$/.test(batch.alias_version)) fail('Versión de abreviaturas inválida.');
    if (Buffer.byteLength(JSON.stringify(batch)) > 131072) fail('Lote demasiado grande.');
    const ids = batch.ops.map(op => {
        if (!op || typeof op !== 'object' || Array.isArray(op)) fail('Operación inválida.');
        return validId(op.client_op_id);
    });
    if (new Set(ids).size !== ids.length) fail('Operaciones repetidas dentro del lote.');
}
function addFinding(tooth, data, id, actor, revision) {
    const definition = CATALOG.find(item => item.code === data.code);
    if (!definition) fail('Hallazgo no reconocido.');
    const intent = data.intent || definition.intent;
    if (![definition.intent, ...(definition.kind === 'restoration' || definition.kind === 'procedure' ? ['indicated'] : [])].includes(intent)) fail('Intención incompatible.');
    let location;
    try { location = normalizeLocation(data.surfaces, data.surface_pending === undefined ? false : data.surface_pending); }
    catch (error) { fail(error.message); }
    if (definition.surface && location.surfaces === null && !location.surface_pending) fail('Indica caras o localización pendiente.');
    if (!definition.surface && (location.surfaces !== null || location.surface_pending)) fail('Este hallazgo corresponde a la pieza completa.');
    const item = { id, ...definition, intent, ...location, status: 'active', actor, created_revision: revision };
    const same = tooth.findings.find(f => f.status === 'active' && f.code === item.code && f.intent === intent && f.surfaces === item.surfaces && f.surface_pending === item.surface_pending);
    if (same && data.overlap_choice !== 'merge') return same;
    if (data.overlap_choice === 'merge') {
        if (!item.surfaces) fail('Solo se fusionan hallazgos con caras conocidas.');
        let faces=item.surfaces,origins=[];
        while(true) {
            const matches=tooth.findings.filter(f=>f.status==='active'&&f.code===item.code&&f.intent===intent&&f.surfaces&&[...faces].some(face=>f.surfaces.includes(face)));
            const combined=normalizeSurfaces(faces+matches.map(f=>f.surfaces).join(''));
            origins=matches;if(combined===faces)break;faces=combined;
        }
        if(!origins.length)fail('No hay hallazgos compatibles para fusionar.',409);
        if(origins.length===1&&origins[0].surfaces===faces)return origins[0];
        if(tooth.findings.some(f=>f.id===id))fail('Identidad de hallazgo reutilizada.',409);
        origins.forEach(f=>{f.status='corrected';f.corrected_revision=revision;f.merged_into=id;});
        item.surfaces=faces;item.merged_from=origins.map(f=>f.id);tooth.findings.push(item);return item;
    }
    if (item.surfaces && tooth.findings.some(f => f.status === 'active' && f.code === item.code && f.intent === intent && f.surfaces && [...item.surfaces].some(face => f.surfaces.includes(face))) && data.overlap_choice !== 'separate') {
        fail('Hay caras solapadas. Confirma explícitamente si deseas un hallazgo separado.');
    }
    if (tooth.findings.some(f => f.id === id)) fail('Identidad de hallazgo reutilizada.', 409);
    tooth.findings.push(item);
    return item;
}
function applyBatch(chart, batch, actor, undoEvents = {}) {
    validateBatch(batch);
    if (batch.catalog_version !== CATALOG_VERSION) fail('El catálogo cambió; recarga.', 409, 'CO26_CATALOG');
    if (chart.status !== 'active' || chart.generation !== batch.generation) fail('El odontograma ya no pertenece a esta visita del editor.', 409, 'CO26_GENERATION');
    if (batch.base_revision > chart.revision) fail('Revisión futura.', 409);
    const next = clone(chart), events = [], affected = new Set();
    const revision = chart.revision + 1;
    for (const op of batch.ops) {
        let n;
        try { n = toothNumber(op.tooth); } catch (error) { fail(error.message); }
        const tooth = next.teeth[n];
        if (!tooth) fail('La pieza no pertenece a esta dentición.');
        if (chart.teeth[n].version > batch.base_revision) fail('La pieza cambió; compara los cambios antes de reaplicar.', 409, 'CO26_TOOTH_CONFLICT');
        const before = clone(tooth);
        const finding = () => {
            const f = tooth.findings.find(item => item.id === op.finding_id);
            if (!f) fail('Hallazgo no disponible.', 409);
            return f;
        };
        if (op.type === 'operation.undo') {
            const target = undoEvents[op.target_op_id];
            if (!target || target.actor !== actor || target.event.tooth !== n || !target.event.noop && chart.teeth[n].version !== target.revision) fail('La operación cambió o no pertenece a esta captura.', 409);
            if (!target.event.noop) Object.assign(tooth, clone(target.event.before));
        } else if (op.type === 'finding.add') addFinding(tooth, op, op.client_op_id, actor, revision);
        else if (op.type === 'finding.remove') {
            const f = finding();
            if (f.status !== 'active') fail('El hallazgo ya cambió.', 409);
            f.status = 'corrected'; f.corrected_revision = revision;
        } else if (op.type === 'finding.restore') {
            const f = finding();
            if (f.status !== 'corrected') fail('Solo se restaura una corrección explícita.', 409);
            f.status = 'active'; delete f.corrected_revision;
        } else if (op.type === 'finding.surface') {
            const f = finding();
            if (f.status !== 'active' || !f.surface) fail('No se pueden cambiar estas caras.');
            let location;
            try { location = normalizeLocation(op.surfaces, op.surface_pending === undefined ? false : op.surface_pending); }
            catch (error) { fail(error.message); }
            if (location.surfaces === null && !location.surface_pending) fail('Indica las caras pendientes explícitamente.');
            Object.assign(f, location);
        } else if (op.type === 'finding.evolve') {
            if (!Array.isArray(op.origins) || !op.origins.length || new Set(op.origins).size !== op.origins.length || !Array.isArray(op.results) || op.results.length > 20) fail('Selecciona origen y resultados de la evolución.');
            const origins = op.origins.map(id => tooth.findings.find(f => f.id === id && f.status === 'active'));
            if (origins.some(f => !f)) fail('El origen de la evolución cambió.', 409);
            origins.forEach(f => { f.status = 'resolved'; f.evolution_id = op.client_op_id; });
            op.results.forEach((result, index) => {
                const f = addFinding(tooth, result, op.client_op_id + '-' + index, actor, revision);
                if (f.id !== op.client_op_id + '-' + index) fail('El resultado ya existe; revisa la evolución antes de vincularlo.');
                if (origins.some(origin => origin.id === f.id)) fail('Origen y resultado de evolución deben ser distintos.');
                f.origin_ids = [...op.origins];
            });
        } else if (op.type === 'finding.evolve.undo') {
            const origins = tooth.findings.filter(f => f.status === 'resolved' && f.evolution_id === op.evolution_id);
            const results = tooth.findings.filter(f => f.status === 'active' && f.origin_ids && f.origin_ids.some(id => origins.some(origin => origin.id === id)));
            if (!origins.length || results.some(f => f.created_revision <= batch.base_revision && f.evolution_undone)) fail('La evolución ya cambió.', 409);
            origins.forEach(f => { f.status = 'active'; delete f.evolution_id; });
            results.forEach(f => { f.status = 'corrected'; f.evolution_undone = op.client_op_id; });
        } else if (op.type === 'presence.correct') {
            tooth.findings.filter(f=>f.kind==='presence'&&f.status==='active').forEach(f=>{f.status='corrected';f.corrected_revision=revision;f.correction_reason='presence_correction';});
        } else if (op.type === 'tooth.review') {
            if (tooth.reviewed_revision === null || tooth.reviewed_revision < tooth.version || tooth.review_invalidated) tooth.reviewed_revision = revision;
            tooth.review_invalidated = false;
        }
        else if (op.type === 'tooth.unreview') { tooth.reviewed_revision = null; tooth.review_invalidated = false; }
        else if (op.type === 'note.set') {
            if (typeof op.text !== 'string' || op.text.length > 1000) fail('La nota admite hasta 1000 caracteres.');
            tooth.note = op.text;
        } else fail('Operación no reconocida.');
        if (canonical(before) !== canonical(tooth)) {
            if (!['tooth.review','tooth.unreview','operation.undo'].includes(op.type) && tooth.reviewed_revision !== null) tooth.review_invalidated = true;
            // Review is preserved as a historical fact; version flags later changes.
            affected.add(n);
            events.push({ client_op_id: op.client_op_id, type: op.type, tooth: n, before, after: clone(tooth) });
        }
    }
    // Reject exact duplicates created by surface edits rather than losing identities.
    for (const n of affected) {
        const keys = next.teeth[n].findings.filter(f => f.status === 'active').map(f => canonical([f.code, f.intent, f.surfaces, f.surface_pending]));
        if (new Set(keys).size !== keys.length) fail('El cambio duplica un hallazgo existente.');
        next.teeth[n].version = revision;
    }
    if (affected.size) {
        if(Object.values(next.teeth).some(tooth=>tooth.findings.length>LIMITS.findings_per_tooth)||Buffer.byteLength(JSON.stringify(next))>LIMITS.snapshot_bytes)fail('El registro alcanzó su límite de volumen. Conserva su historial y crea un nuevo odontograma para continuar.',422,'CO26_VOLUME_LIMIT');
        next.revision = revision; next.catalog_version = CATALOG_VERSION;
    }
    return { chart: next, events, changed: affected.size > 0 };
}
module.exports = { CATALOG, CATALOG_VERSION, LIMITS, emptyChart, applyBatch, validateBatch, canonical, hash, validId, fail, clone };

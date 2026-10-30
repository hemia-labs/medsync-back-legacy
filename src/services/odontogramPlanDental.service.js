'use strict';
const { QueryTypes } = require('sequelize');
const { randomUUID } = require('node:crypto');
const sequelize = require('../db/Sequelize.connection');
const D = require('../domain/odontogram/operations');
const { mergeDental } = require('../domain/odontogram/planDental');
const query = (sql, values, transaction) => sequelize.query(sql, { replacements: values, transaction, logging: false,
    type: /^\s*SELECT/.test(sql) ? QueryTypes.SELECT : QueryTypes.RAW });
const missing = error => (error.original || error).code === 'ER_NO_SUCH_TABLE';
async function schemaReady(transaction) {
    try { await query('SELECT revision FROM odontogram_plan_dental_revision LIMIT 0', {}, transaction); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
}
async function load(business, id, teeth, transaction) {
    const fallback = teeth.map(tooth_number => ({ tooth_number: String(tooth_number), surfaces: null, manual: true, sources: [] }));
    let versions;
    try { versions = await query('SELECT revision,form_revision FROM odontogram_plan_dental_revision WHERE id_business=:business AND id_treatment=:id', { business, id }, transaction); }
    catch (error) { if (missing(error)) return { available: false, revision: 0, details: fallback }; throw error; }
    if (!versions.length) return { available: true, revision: 0, form_revision: 0, details: fallback };
    const details = await query('SELECT tooth_number,surfaces,manual FROM odontogram_plan_dental_detail WHERE id_business=:business AND id_treatment=:id ORDER BY tooth_number', { business, id }, transaction);
    const sources = await query('SELECT tooth_number,source_key,id_chart,finding_id,source_revision,context_json FROM odontogram_plan_dental_source WHERE id_business=:business AND id_treatment=:id ORDER BY source_key', { business, id }, transaction);
    const manual = await query('SELECT tooth_number,surfaces FROM odontogram_plan_dental_manual WHERE id_business=:business AND id_treatment=:id', { business, id }, transaction);
    const combined = new Map(fallback.map(detail => [detail.tooth_number, detail]));
    for (const detail of details) combined.set(detail.tooth_number, { ...detail, manual: Boolean(detail.manual), manual_surfaces: manual.some(item=>item.tooth_number===detail.tooth_number) ? manual.find(item=>item.tooth_number===detail.tooth_number).surfaces : detail.surfaces,
        sources: sources.filter(source => source.tooth_number === detail.tooth_number).map(source => ({ source_key: source.source_key, id_chart: source.id_chart,
            finding_id: source.finding_id, revision: source.source_revision, context: JSON.parse(source.context_json) })) });
    return { available: true, revision: versions[0].revision, form_revision: versions[0].form_revision, details: [...combined.values()].sort((a,b) => a.tooth_number.localeCompare(b.tooth_number)) };
}
async function resolveSource(body, source, tooth, transaction) {
    const charts = await query('SELECT id_person,revision,status FROM odontogram_v2_chart WHERE id_business=:business AND id_chart=:chart', { business: body.id_business, chart: source.id_chart }, transaction);
    if (!charts.length || charts[0].id_person !== body.id_person || charts[0].status === 'deleted') D.fail('Origen dental no disponible para este paciente.', 403);
    if (source.is_current === true && charts[0].revision !== source.revision) D.fail('El origen cambió; vuelve a consultar la selección.', 409);
    const versions = await query('SELECT snapshot_json FROM odontogram_v2_revision WHERE id_business=:business AND id_chart=:chart AND revision=:revision', { business: body.id_business, chart: source.id_chart, revision: source.revision }, transaction);
    if (!versions.length) D.fail('Revisión de origen no disponible.', 409);
    const snapshot = JSON.parse(versions[0].snapshot_json), state = snapshot.teeth[tooth];
    if (!state) D.fail('La pieza no pertenece al origen seleccionado.');
    const finding = source.finding_id ? state.findings.find(f => f.id === source.finding_id && f.status === 'active') : null;
    if (source.finding_id && !finding) D.fail('El hallazgo no está vigente en la revisión elegida.', 409);
    return { context: { dentition: snapshot.mode, tooth_number: tooth, label: finding ? finding.label : 'Pieza ' + tooth,
        intent: finding ? finding.intent : null, surfaces: finding ? finding.surfaces : null, surface_pending: finding ? finding.surface_pending : false } };
}
async function prepare(body, id, teeth, transaction, canReadOdontogram) {
    const previous = await load(body.id_business, id, teeth, transaction);
    if (!previous.available && body.tooth_details !== undefined) D.fail('Falta instalar la ampliación dental del plan.', 503);
    const merged = await mergeDental(previous.details, body, { revision: previous.revision, canReadOdontogram,
        resolveSource: (source, tooth) => resolveSource(body, source, tooth, transaction) });
    return { ...previous, next: merged.details, changed: merged.changed };
}
async function persist(body, id, prepared, transaction) {
    if (!prepared.changed || !prepared.available) return;
    const values = { business: body.id_business, id, actor: body.id_login, revision: prepared.revision + 1 };
    await query(`INSERT INTO odontogram_plan_dental_revision(id_business,id_treatment,revision) VALUES(:business,:id,:revision)
        ON DUPLICATE KEY UPDATE revision=VALUES(revision)`, values, transaction);
    for (const old of prepared.details.filter(old => !prepared.next.some(detail => detail.tooth_number === old.tooth_number))) {
        await query('DELETE FROM odontogram_plan_dental_manual WHERE id_business=:business AND id_treatment=:id AND tooth_number=:tooth', { ...values, tooth: old.tooth_number }, transaction);
        await query('DELETE FROM odontogram_plan_dental_source WHERE id_business=:business AND id_treatment=:id AND tooth_number=:tooth', { ...values, tooth: old.tooth_number }, transaction);
        await query('DELETE FROM odontogram_plan_dental_detail WHERE id_business=:business AND id_treatment=:id AND tooth_number=:tooth', { ...values, tooth: old.tooth_number }, transaction);
    }
    for (const detail of prepared.next) {
        const keys = { ...values, tooth: detail.tooth_number };
        await query(`INSERT INTO odontogram_plan_dental_detail(id_business,id_treatment,tooth_number,surfaces,manual)
            VALUES(:business,:id,:tooth,:surfaces,:manual) ON DUPLICATE KEY UPDATE surfaces=VALUES(surfaces),manual=VALUES(manual)`, { ...keys, surfaces: detail.surfaces, manual: detail.manual ? 1 : 0 }, transaction);
        await query(`INSERT INTO odontogram_plan_dental_manual(id_business,id_treatment,tooth_number,surfaces) VALUES(:business,:id,:tooth,:surfaces)
            ON DUPLICATE KEY UPDATE surfaces=VALUES(surfaces)`, { ...keys, surfaces: detail.manual_surfaces || null }, transaction);
        const old = prepared.details.find(item => item.tooth_number === detail.tooth_number);
        for (const source of old && old.sources || []) if (!detail.sources.some(item => item.source_key === source.source_key)) await query('DELETE FROM odontogram_plan_dental_source WHERE id_business=:business AND id_treatment=:id AND tooth_number=:tooth AND source_key=:key', { ...keys, key: source.source_key }, transaction);
        for (const source of detail.sources) await query(`INSERT INTO odontogram_plan_dental_source(id_business,id_treatment,tooth_number,source_key,id_chart,finding_id,source_revision,context_json)
            VALUES(:business,:id,:tooth,:key,:chart,:finding,:sourceRevision,:context) ON DUPLICATE KEY UPDATE source_revision=VALUES(source_revision),context_json=VALUES(context_json)`,
        { ...keys, key: source.source_key, chart: source.id_chart, finding: source.finding_id, sourceRevision: source.revision, context: JSON.stringify(source.context) }, transaction);
    }
    await query(`INSERT INTO odontogram_plan_dental_event(id_event,id_business,id_treatment,revision,event_kind,actor,before_json,after_json,created_at)
        VALUES(:event,:business,:id,:revision,'dental',:actor,:before,:after,NOW(3))`, { ...values, event: randomUUID(), before: JSON.stringify(prepared.details), after: JSON.stringify(prepared.next) }, transaction);
}
async function attach(body, items, transaction, includeSources = false) {
    const enriched = [];
    for (const item of items) {
        const dental = await load(body.id_business, item.id_patient_treatment, item.teeth || [], transaction);
        if (!dental.available) { enriched.push(item); continue; }
        enriched.push({ ...item, teeth: dental.details.map(detail => detail.tooth_number), dental_revision: dental.revision, treatment_revision: dental.form_revision, tooth_details: dental.details.map(detail => {
            if (includeSources) return detail;
            const safe = { ...detail, sources_redacted: Boolean(detail.sources.length) }; delete safe.sources; return safe;
        }) });
    }
    return enriched;
}
function requestHash(body) {
    const fields = ['id_business','id_login','id_person','id_treatment_plan','request_id','name','description','category','estimated_start_date','estimated_end_date','cost','notes','teeth','tooth_details'];
    return D.hash(Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(body,key)).map(key => [key,body[key]])));
}
async function formState(body, id, transaction, isUpdate) {
    let rows;
    try { rows = await query('SELECT form_revision,create_request_hash FROM odontogram_plan_dental_revision WHERE id_business=:business AND id_treatment=:id', { business:body.id_business,id }, transaction); }
    catch (error) { if (missing(error)) return { available:false,revision:0 }; throw error; }
    const revision = rows[0] && rows[0].form_revision || 0;
    if (isUpdate && (body.treatment_revision !== undefined ? body.treatment_revision !== revision : revision > 0)) D.fail('El tratamiento cambió o el cliente no envió su revisión. Recarga el formulario.',409,'CO26_TREATMENT_REVISION');
    return { available:true,revision,create_hash:rows[0] && rows[0].create_request_hash };
}
async function assertCreateRetry(body,id,transaction) {
    const state=await formState(body,id,transaction,false);
    if (state.available && (!state.create_hash || state.create_hash !== requestHash(body))) D.fail('El identificador de creación ya corresponde a otro contenido. Recarga el plan.',409,'CO26_TREATMENT_REQUEST');
}
async function recordForm(body,id,state,before,after,transaction,isUpdate) {
    if (!state.available) return;
    const values={business:body.id_business,id,actor:body.id_login,revision:state.revision+1,hash:isUpdate?null:requestHash(body)};
    await query(`INSERT INTO odontogram_plan_dental_revision(id_business,id_treatment,revision,form_revision,create_request_hash)
        VALUES(:business,:id,0,:revision,:hash) ON DUPLICATE KEY UPDATE form_revision=VALUES(form_revision),create_request_hash=COALESCE(create_request_hash,VALUES(create_request_hash))`,values,transaction);
    await query(`INSERT INTO odontogram_plan_dental_event(id_event,id_business,id_treatment,revision,event_kind,actor,before_json,after_json,created_at)
        VALUES(:event,:business,:id,:revision,'form',:actor,:before,:after,NOW(3))`,{...values,event:randomUUID(),before:JSON.stringify(before||null),after:JSON.stringify(after)},transaction);
}
module.exports = { load, prepare, persist, attach, resolveSource, schemaReady, formState, assertCreateRetry, recordForm };

'use strict';
const { createHash } = require('crypto');
const { isDeepStrictEqual } = require('util');
const { QueryTypes } = require('sequelize');
const db = require('../../db/Sequelize.connection');
const tracing = require('./tracing.Dao');
const consentDocuments = require('../../services/documentSignature/treatmentPlanConsentDocument.service');
const drafts = require('./evolutionDraft.dao');
const dental = require('../../services/odontogramPlanDental.service');
const effectivePermissions = require('../../util/effectivePermissions');
const response = require('../../util/responsedata');
const { listPage, pageWindow, pageData } = require('../../util/listPage');
const { recordPerformedExtra } = require('../../services/evolutionPerformedExtra');

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const table = 'evolution_note_signed_version';
const scope = 'id_business=:business AND id_person=:patient';
const noteScope = scope + ' AND note_id=:id';
const conflict = message => ({status:409, data:null, message});
const keys = body => ({business:body.id_business, patient:body.id_person, actor:body.id_login, id:body.id});
function snapshot(row) {
    return {id:row.note_id, version:row.version, author:row.author_id, signer:row.signer_name,
        license:row.signer_license, signedAt:row.signed_at, reason:row.correction_reason,
        form:typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload};
}

async function read(body) {
    let page;
    try { page=listPage({page:body.page || '1',page_size:10}); }
    catch { return response.bad_request('Página inválida.'); }
    return db.transaction(async transaction => {
        const access=await tracing.context(body,'px.tab.monitoring',transaction);
        if (access.error) return access.error;
        const replacements=keys(body);
        const select=sql => db.query(sql,{transaction,replacements,type:QueryTypes.SELECT});
        const where=body.id ? noteScope : scope + ' AND version=(SELECT MAX(v.version) FROM '+table+' v WHERE v.id_business=n.id_business AND v.id_person=n.id_person AND v.note_id=n.note_id)';
        const from=' FROM '+table+' n WHERE '+where;
        const [count]=await select('SELECT COUNT(*) AS total'+from);
        const window=pageWindow(page,count.total);
        replacements.offset=window.offset;
        const rows=await select('SELECT n.*'+from+' ORDER BY signed_at DESC, version DESC, note_id LIMIT 10 OFFSET :offset');
        return response.success(pageData(rows.map(snapshot),window),'Firmas profesionales consultadas.');
    });
}

async function completePerformed(body, procedures, previous, transaction) {
    const existing = new Set((previous?.done || []).map(item => item.id));
    const ids = procedures.map(item => item.id).filter(id => !existing.has(id));
    if (!ids.length) return {};
    const replacements = {...keys(body), ids};
    const rows = await db.query(`SELECT pt.*,tp.status AS planStatus,tp.title AS planTitle FROM patient_treatment pt JOIN treatment_plan tp
        ON tp.id_treatment_plan=pt.id_treatment_plan AND tp.id_person=pt.id_person AND tp.id_business=pt.id_business
        WHERE pt.id_business=:business AND pt.id_person=:patient AND pt.id_patient_treatment IN (:ids)
        AND pt.active=1 AND pt.status<>'cancelled' AND tp.active=1 AND tp.status IN ('active','closed') FOR UPDATE`,
        {transaction,replacements,type:QueryTypes.SELECT});
    if (rows.length !== ids.length) return {error:conflict('El plan cambió. Revisa los procedimientos realizados antes de firmar.')};
    const closed = rows.filter(item=>item.planStatus==='closed');
    const pending = closed.filter(item=>item.status!=='completed');
    const confirmed = new Set(body.confirmedClosed || []);
    if(pending.some(item=>!confirmed.has(item.id_patient_treatment))) {
        return {error:{status:409,message:'Confirma los procedimientos de planes cerrados.',data:{
            code:'CONFIRM_CLOSED_PROCEDURES', items:pending.map(item=>({id:item.id_patient_treatment,name:item.name,plan:item.planTitle}))
        }}};
    }
    for(const item of closed){
        const procedure=procedures.find(p=>p.id===item.id_patient_treatment);
        Object.assign(procedure,{planId:item.id_treatment_plan,planTitle:item.planTitle,closedPlan:true,noteOnly:item.status!=='completed'});
    }
    const changed = rows.filter(item => item.planStatus==='active' && item.status !== 'completed');
    if (!changed.length) return {};
    const grants = await effectivePermissions.rows(body.id_login,{enabledCatalog:true,transaction});
    if (!grants.some(({code}) => ['treatments.edit','treatments.complete'].includes(code)))
        return {error:response.forbidden('Necesitas permiso para completar los procedimientos del plan.')};
    for (const row of changed) {
        const id = row.id_patient_treatment;
        const state = await dental.formState(body,id,transaction,false);
        await db.query(`UPDATE patient_treatment SET status='completed',updated_at=NOW(),updated_by=:actor
            WHERE id_business=:business AND id_person=:patient AND id_patient_treatment=:item`,
            {transaction,replacements:{...keys(body),item:id}});
        await dental.recordForm(body,id,state,row,{...row,status:'completed'},transaction,true);
    }
    return {changed:true};
}

async function attest(body, correcting) {
    if (!uuid.test(body.id) || !uuid.test(body.requestId) || !Number.isSafeInteger(body.revision) || body.revision<1)
        return response.bad_request('Revisa la versión y la solicitud de firma.');
    let form;
    const reason=correcting && typeof body.reason==='string' ? body.reason.trim() : '';
    if (correcting) {
        if (!reason || reason.length>1000) return response.bad_request('Indica el motivo de la rectificación (hasta 1000 caracteres).');
        try { form=drafts.normalize(body.form); } catch(error) { return response.bad_request(error.message); }
    }
    const payload=[correcting,body.revision,reason,form];
    if(body.confirmedClosed!==undefined){
        if(!Array.isArray(body.confirmedClosed) || body.confirmedClosed.length>500 || body.confirmedClosed.some(id=>typeof id!=='string'||id.length>50))
            return response.bad_request('Revisa los procedimientos que deseas confirmar.');
        if(body.confirmedClosed.length) payload.push([...new Set(body.confirmedClosed)].sort());
    }
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return db.transaction(async transaction => {
        await tracing.lockPatient(body,transaction);
        const access=await tracing.context(body,correcting?'tracing.correct':'tracing.create',transaction);
        if (access.error) return access.error;
        const replacements={...keys(body),request:body.requestId};
        const select=sql => db.query(sql,{transaction,replacements,type:QueryTypes.SELECT});
        const [prior]=await select('SELECT * FROM '+table+' WHERE '+noteScope+' ORDER BY version DESC LIMIT 1 FOR UPDATE');
        if (prior && prior.author_id!==body.id_login) return response.forbidden('Solo quien firmó la nota puede rectificarla.');
        const [replay]=await select('SELECT * FROM '+table+' WHERE '+noteScope+' AND request_id=:request');
        if (replay) return replay.request_hash===hash ? response.success(snapshot(replay),'Firma registrada.') : conflict('La solicitud anterior tenía otro contenido.');
        if (!correcting && prior) return conflict('Esta nota ya está firmada. Consulta su historial.');
        if (correcting && (!prior || prior.version!==body.revision)) return conflict('La versión cambió. Consulta el historial antes de rectificar.');
        const [profile]=await select('SELECT id_doctor_professional_profile, professional_name, professional_license FROM doctor_professional_profile WHERE id_business=:business AND id_login=:actor AND is_active=1');
        if (!profile?.professional_name?.trim() || !profile.professional_license?.trim())
            return response.forbidden('Para firmar necesitas un perfil profesional activo con nombre y cédula.');
        let draftRevision;
        if (correcting) {
            const original=snapshot(prior).form;
            if (form.origin!==original.origin) return response.bad_request('La rectificación debe conservar la cita de origen.');
            if (!await drafts.canonicalSelections(form,original,replacements,transaction)) return response.bad_request('Revisa los tratamientos del paciente.');
            if (isDeepStrictEqual(form,original)) return response.bad_request('Modifica al menos un dato de la nota.');
            draftRevision=prior.draft_revision;
        } else {
            const [draft]=await select('SELECT * FROM evolution_note_draft WHERE '+scope+' AND author_id=:actor AND draft_id=:id FOR UPDATE');
            if (!draft) return response.notSuccess('Borrador no encontrado.');
            if (draft.revision!==body.revision) return conflict('El borrador cambió. Vuelve a revisar la versión guardada.');
            form=drafts.decode(draft).form;
            draftRevision=draft.revision;
        }
        if (!drafts.complete(form)) return response.bad_request('Completa los datos de la nota antes de firmar.');
        const previous = prior && snapshot(prior).form;
        const completion = await completePerformed(body,form.done,previous,transaction);
        if (completion.error) return completion.error;
        const version=prior ? prior.version+1 : 1;
        Object.assign(replacements,{version,draftRevision,hash,profile:profile.id_doctor_professional_profile,
            name:profile.professional_name,license:profile.professional_license,payload:JSON.stringify(form),reason:reason || null});
        await db.query('INSERT INTO '+table+' (id_business,id_person,note_id,version,draft_revision,request_id,request_hash,author_id,signer_profile,signer_name,signer_license,signed_at,payload,correction_reason) VALUES (:business,:patient,:id,:version,:draftRevision,:request,:hash,:actor,:profile,:name,:license,UTC_TIMESTAMP(6),:payload,:reason)',{transaction,replacements});
        const addedExtra = form.performed && !previous?.performed;
        if (addedExtra) {
            await recordPerformedExtra(db,transaction,{...keys(body),note:body.id,name:form.performed,date:form.date});
        }
        if (addedExtra || completion.changed) await consentDocuments.invalidateStale(body,transaction);
        const [saved]=await select('SELECT * FROM '+table+' WHERE '+noteScope+' AND version=:version');
        return response.success(snapshot(saved),correcting?'Rectificación firmada.':'Firma profesional registrada.');
    });
}
module.exports={read,attest};

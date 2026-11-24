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
const integrity = require('../../services/evolutionIntegrity.service');
const witness = require('../../services/evolutionIntegrityWitness.service');
const reconciler = require('../../services/evolutionIntegrityReconciler');
const { listPage, pageWindow, pageData } = require('../../util/listPage');
const { recordPerformedExtra } = require('../../services/evolutionPerformedExtra');

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const table = 'evolution_note_signed_version';
const scope = 'id_business=:business AND id_person=:patient';
const noteScope = scope + ' AND note_id=:id';
const conflict = message => ({status:409, data:null, message});
const unavailable = code => ({status:503, data:{code}, message:'No pudimos comprobar la integridad de la nota. Consulta el historial y vuelve a intentarlo. Si el aviso continúa, contacta a Soporte de HEMIA.'});
const integrityConflict = code => ({status:409, data:{code}, message:'El historial requiere revisión. Contacta a Soporte de HEMIA e informa al responsable del consultorio.'});
const keys = body => ({business:body.id_business, patient:body.id_person, actor:body.id_login, id:body.id});
function snapshot(row) {
    return {id:row.note_id, version:row.version, author:row.author_id, signer:row.signer_name,
        license:row.signer_license, signedAt:row.signed_at, reason:row.correction_reason,
        form:typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload};
}

const placeholder = (extra, note) => ({ id: note, version: null, author: null, signer: null, license: null, signedAt: null, reason: null, form: null, ...extra });
async function verification(replacements, rows, onlyNote, transaction) {
    const base = await baseVerification(replacements, rows, onlyNote, transaction);
    // C22: un retroceso detectado por el conciliador se refleja en el aviso aunque MySQL, por sí solo, se vea coherente.
    const live = reconciler.shared();
    const extra = live ? live.faultsFor(replacements.business, replacements.patient) : [];
    const warnings = live ? live.warningsFor(replacements.business, replacements.patient) : [];
    // `correctionBlocked` es la regla local que también aplica la escritura (discrepancia o indisponibilidad de la cadena de la nota):
    // pantalla y API deciden con ella, no con el aviso del conciliador, que no bloquea nada.
    const correctionBlocked = ['discrepancy', 'unavailable'].includes(base.state);
    if (!extra.length) return { ...base, correctionBlocked, warnings };
    return { ...base, state: 'discrepancy', faults: [...base.faults, ...extra], reference: true, correctionBlocked, warnings };
}
async function baseVerification(replacements, rows, onlyNote, transaction) {
    const cfg = integrity.config();
    try {
        const ref = await integrity.loadReference(db, transaction, replacements);
        if (!ref.entries.length && !ref.head && !cfg.adoptionAt)
            return { state: 'historical', notes: new Map(), faults: [], reference: false };
        return { ...integrity.verify({ rows, entries: ref.entries, head: ref.head, cfg, onlyNote }), reference: true };
    } catch (error) {
        console.error('EVOLUTION_INTEGRITY_UNAVAILABLE', error.code || error.message);
        return { state: 'unavailable', notes: new Map(), faults: [{ code: 'REFERENCE_UNAVAILABLE', state: 'unavailable' }], unavailable: true, reference: false };
    }
}

// Estado de la confirmación externa por versión: pending, conflict, received (acuse), unknown (cola ilegible) o null
// (nota heredada o ambiente sin testigo: no hay nada que comprobar).
async function externalStates(replacements, note, transaction) {
    if (!witness.config().enabled) return { disabled: true, ok: true, states: new Map() };
    return witness.readStates(db,{business:replacements.business,patient:replacements.patient,note},transaction);
}
const externalMark = (delivery, row, mark) => {
    if (delivery.disabled || mark.state === 'historical') return null;
    if (!delivery.ok) return 'unknown';
    const state = delivery.states.get(row.note_id+'#'+row.version);
    // Versión sellada sin fila de entrega: sin evidencia de acuse la incertidumbre se conserva (no es «ninguno»).
    return state === 'acked' ? 'received' : state || 'unknown';
};

async function read(body) {
    let page;
    try { page=listPage({page:body.page || '1',page_size:10}); }
    catch { return response.bad_request('Página inválida.'); }
    return db.transaction(async transaction => {
        const access=await tracing.context(body,'px.tab.monitoring',transaction);
        if (access.error) return access.error;
        const replacements=keys(body);
        const rows=await db.query('SELECT '+integrity.ROW_SELECT+' FROM '+table+' n WHERE '+(body.id ? noteScope : scope),{transaction,replacements,type:QueryTypes.SELECT});
        const check=await verification(replacements,rows,body.id || null,transaction);
        const delivery=await externalStates(replacements,body.id || null,transaction);
        const stateOf=(note,version)=>{
            if (check.unavailable) return {state:'unavailable',code:'REFERENCE_UNAVAILABLE'};
            const entry=check.notes.get(note);
            const found=version===undefined ? entry : entry && entry.versions.get(version);
            return found ? {state:found.state,code:found.code} : {state:'historical',code:null};
        };
        const items=[];
        if (body.id) {
            const numbers=new Set(rows.map(row => row.version));
            const entry=check.notes.get(body.id);
            if (entry) for (const version of entry.versions.keys()) numbers.add(version);
            for (const version of [...numbers].sort((a,b) => b-a)) {
                const row=rows.find(r => r.version===version), mark=stateOf(body.id,version);
                items.push(!row || mark.state==='discrepancy'
                    ? placeholder({version,integrity:mark},body.id)
                    : {...snapshot(row),integrity:{...mark,external:externalMark(delivery,row,mark)}});
            }
        } else {
            const latest=new Map();
            for (const row of rows) if (!latest.has(row.note_id) || row.version>latest.get(row.note_id).version) latest.set(row.note_id,row);
            const live=[...latest.values()].sort((a,b) => b.signed_at_text.localeCompare(a.signed_at_text) || b.version-a.version || a.note_id.localeCompare(b.note_id));
            const flagged=[];
            for (const row of live) {
                const mark=stateOf(row.note_id);
                if (mark.state==='discrepancy') flagged.push(placeholder({integrity:mark},row.note_id));
                else items.push({...snapshot(row),integrity:{...mark,external:externalMark(delivery,row,mark)}});
            }
            for (const [note,entry] of check.notes) if (!latest.has(note)) flagged.push(placeholder({integrity:{state:entry.state,code:entry.code}},note));
            const open=check.faults.find(f => f.state==='discrepancy');
            if (open && !flagged.length) flagged.push(placeholder({integrity:{state:'discrepancy',code:open.code}},null));
            items.unshift(...flagged);
        }
        const window=pageWindow(page,items.length);
        for (const item of items) if (['discrepancy','unavailable'].includes(item.integrity.state))
            integrity.recordEvent({type:'READ_'+item.integrity.state.toUpperCase(),code:item.integrity.code,business:body.id_business,patient:body.id_person,note:item.id,version:item.version,actor:body.id_login});
        const summary={state:check.state,faults:check.faults.map(f => f.code),reference:check.reference,correctionBlocked:Boolean(check.correctionBlocked),warnings:(check.warnings || []).map(w => w.code),externalPending:items.filter(item => item.integrity.external==='pending').length};
        const data=pageData(items.slice(window.offset,window.offset+window.pageSize),window);
        return response.success({...data,integrity:summary},check.state==='discrepancy' ? 'Se detectó una diferencia en el control de integridad.' : 'Firmas profesionales consultadas.');
    });
}

async function completePerformed(body, procedures, previous, transaction) {
    const existing = new Set((previous?.done || []).map(item => item.id));
    const ids = procedures.map(item => item.id).filter(id => !existing.has(id));
    if (!ids.length) return {};
    const replacements = {...keys(body), ids};
    const rows = await db.query(`SELECT pt.*,tp.status AS planStatus,tp.title AS planTitle,DATE_FORMAT(tp.started_at,'%Y-%m-%d') AS startedDate,DATE_FORMAT(tp.closed_at,'%Y-%m-%d') AS closedDate FROM patient_treatment pt JOIN treatment_plan tp
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
            code:'CONFIRM_CLOSED_PROCEDURES', items:pending.map(item=>({id:item.id_patient_treatment,name:item.name,planTitle:item.planTitle,planId:item.id_treatment_plan,startedDate:item.startedDate,closedDate:item.closedDate}))
        }}};
    }
    for(const item of closed){
        const procedure=procedures.find(p=>p.id===item.id_patient_treatment);
        Object.assign(procedure,{planId:item.id_treatment_plan,planTitle:item.planTitle,startedDate:item.startedDate,closedDate:item.closedDate,closedPlan:true,noteOnly:item.status!=='completed'});
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
    let anchor=null, after=null;
    try {
    const result=await db.transaction(async transaction => {
        await tracing.lockPatient(body,transaction);
        const access=await tracing.context(body,correcting?'tracing.correct':'tracing.create',transaction);
        if (access.error) return access.error;
        const replacements={...keys(body),request:body.requestId};
        const select=sql => db.query(sql,{transaction,replacements,type:QueryTypes.SELECT});
        const [prior]=await select('SELECT '+integrity.ROW_SELECT+' FROM '+table+' n WHERE '+noteScope+' ORDER BY version DESC LIMIT 1 FOR UPDATE');
        const noteRows=await select('SELECT '+integrity.ROW_SELECT+' FROM '+table+' n WHERE '+noteScope);
        const cfg=integrity.config();
        let ref=null;
        try { ref=await integrity.loadReference(db,transaction,replacements,true); }
        catch (error) { console.error('EVOLUTION_INTEGRITY_UNAVAILABLE', error.code || error.message); }
        // Sin evidencia de integridad no se firma: evita notas que luego no puedan comprobarse.
        if (!ref || !cfg.current) return unavailable('SEAL_UNAVAILABLE');
        const chain=integrity.verify({rows:noteRows,entries:ref.entries,head:ref.head,cfg,onlyNote:body.id});
        if (chain.faults.length) {
            integrity.recordEvent({type:'SIGN_BLOCKED_CHAIN',code:chain.faults[0].code,business:body.id_business,patient:body.id_person,note:body.id,actor:body.id_login});
            return chain.faults.every(f => f.state==='unavailable') ? unavailable('SEAL_UNAVAILABLE') : integrityConflict(chain.faults[0].code);
        }
        const flagged=chain.notes.get(body.id);
        if (flagged && flagged.state==='discrepancy') {
            integrity.recordEvent({type:correcting?'RECTIFY_BLOCKED_DISCREPANCY':'SIGN_BLOCKED_DISCREPANCY',code:flagged.code,business:body.id_business,patient:body.id_person,note:body.id,actor:body.id_login});
            return integrityConflict(flagged.code);
        }
        if (prior && prior.author_id!==body.id_login) return response.forbidden('Solo quien firmó la nota puede rectificarla.');
        const [replay]=await select('SELECT * FROM '+table+' WHERE '+noteScope+' AND request_id=:request');
        if (replay) {
            if (replay.request_hash!==hash) return conflict('La solicitud anterior tenía otro contenido.');
            const mark=flagged && flagged.versions.get(replay.version);
            if (!mark || mark.state==='unavailable') return unavailable('SEAL_UNAVAILABLE');
            // Reparación idempotente: una firma anterior sin fila de entrega (p. ej. anterior a la cola) la recupera del asiento existente.
            const sealedEntry=ref.entries.find(e => e.note_id===body.id && Number(e.version)===replay.version);
            const marked={...mark};
            if (witness.config().enabled && sealedEntry) {
                try {
                    await witness.enqueue(db,transaction,{business:body.id_business,patient:body.id_person,note:body.id,version:replay.version,seq:sealedEntry.seq});
                    after={business:body.id_business,patient:body.id_person,note:body.id,version:replay.version};
                } catch (error) {
                    // La nota ya está firmada: se informa de la incidencia y se conserva la firma; no se pide firmar otra vez.
                    integrity.recordEvent({type:'EXTERNAL_QUEUE_FAILED',code:String(error.code || error.message).slice(0,40),business:body.id_business,patient:body.id_person,note:body.id,version:replay.version,actor:body.id_login});
                    marked.external='unknown';
                }
            }
            return response.success({...snapshot(replay),integrity:marked},'Firma registrada.');
        }
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
        const [saved]=await select('SELECT '+integrity.ROW_SELECT+' FROM '+table+' n WHERE '+noteScope+' AND version=:version');
        let previousDigest=null;
        if (prior) {
            const sealedBefore=ref.entries.find(e => e.note_id===body.id && Number(e.version)===prior.version);
            previousDigest=sealedBefore ? sealedBefore.digest : integrity.digest(prior);
        }
        const sealed=integrity.seal({cfg,row:saved,previousDigest,head:ref.head});
        await integrity.persistSeal(db,transaction,sealed);
        // La entrega al testigo se encola en la MISMA transacción: firmada implica encolada, sin intervalo entre ambas.
        if (witness.config().enabled) {
            try { await witness.enqueue(db,transaction,{business:body.id_business,patient:body.id_person,note:body.id,version,seq:sealed.entry.seq}); }
            catch (error) { throw new integrity.IntegritySealError('QUEUE_WRITE_FAILED',error); }
            after={business:body.id_business,patient:body.id_person,note:body.id,version};
        }
        anchor=sealed;
        return response.success({...snapshot(saved),integrity:{state:'verified',code:null}},correcting?'Rectificación firmada.':'Firma profesional registrada.');
    });
    if (anchor) await integrity.recordAnchor(anchor);
    if (after && result.data && result.data.integrity) {
        // Intento inmediato antes de responder. El estado devuelto sale de la fila persistida, no de este intento: la respuesta
        // de la firma, el reintento y las lecturas posteriores coinciden. Si el testigo cae, la firma sigue válida y pendiente.
        const wcfg=witness.config();
        try {
            // Un solo intento, limitado a la referencia de esta operación y solo si es la elegible; el resto lo entrega el despachador.
            await witness.deliver(db,wcfg,{business:after.business,patient:after.patient,force:true,only:{note:after.note,version:after.version}});
            const state=await witness.stateOf(db,after);
            result.data.integrity.external=state==='acked' ? 'received' : state || 'unknown';
        } catch (error) {
            // La versión ya está firmada: no se pide firmar otra vez; se informa de la incidencia y se escala a Soporte.
            integrity.recordEvent({type:'EXTERNAL_STATE_UNKNOWN',code:String(error.code || error.message).slice(0,40),business:body.id_business,patient:body.id_person,note:body.id,version:after.version,actor:body.id_login});
            result.data.integrity.external='unknown';
        }
    }
    return result;
    } catch (error) {
        if (!error.integrity) throw error;
        integrity.recordEvent({type:'SEAL_FAILED',code:error.code,business:body.id_business,patient:body.id_person,note:body.id,actor:body.id_login});
        return unavailable('SEAL_FAILED');
    }
}
module.exports={read,attest};

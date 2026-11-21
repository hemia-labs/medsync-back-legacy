'use strict';
const { QueryTypes } = require('sequelize');
const { isDeepStrictEqual } = require('node:util');
const db = require('../../db/Sequelize.connection');
const tracing = require('./tracing.Dao');
const response = require('../../util/responsedata');
const validation = require('../../domain/tracing/tracingValidation');
const { listPage, pageWindow, pageData } = require('../../util/listPage');

const scope = 'id_business=:business AND id_person=:patient AND author_id=:actor';
const keys = body => ({ business:body.id_business, patient:body.id_person, actor:body.id_login });
const decode = row => ({ id:row.draft_id, revision:row.revision, updatedAt:row.updated_at,
    form:typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload });
const conflict = row => ({ status:409, message:'Hay otra versión guardada. Compara los cambios antes de continuar.', data:decode(row) });

function normalize(form) {
    if (!form || typeof form !== 'object') throw new Error('Revisa el contenido del borrador.');
    function selected(values) {
        if (!Array.isArray(values) || values.length > 500) throw new Error('Revisa los procedimientos seleccionados.');
        const ids = values.map(item => validation.text(item && item.id, 50, true));
        if (new Set(ids).size !== ids.length) throw new Error('Hay procedimientos repetidos.');
        return ids;
    }
    const text = (key, max) => validation.text(form[key], max);
    const out = { date:validation.date(form.date,true), origin:text('origin',50),
        reason:text('reason',2000), evolution:text('evolution',10000), plan:text('plan',10000),
        performed:text('performed',255), indication:text('indication',2000), none:form.none === true,
        done:selected(form.done), future:selected(form.future) };
    if (out.none && (out.done.length || out.performed)) throw new Error('Revisa los procedimientos realizados.');
    return out;
}

const eligiblePlans = "id_business=:business AND id_person=:patient AND active=1";
async function procedureOptions(body) {
    return db.transaction(async transaction => {
        const access=await tracing.context(body,'px.tab.monitoring',transaction);
        if(access.error) return access.error;
        const replacements=keys(body);
        const query=sql=>db.query(sql,{transaction,replacements,type:QueryTypes.SELECT});
        let plans=await query("SELECT id_treatment_plan AS id,title FROM treatment_plan WHERE "+eligiblePlans+" AND status='active'");
        const active=plans.length>0;
        if(!active) {
            plans=await query("SELECT id_treatment_plan AS id,title,DATE_FORMAT(closed_at,'%Y-%m-%d') AS closedDate FROM treatment_plan WHERE "+
                eligiblePlans+" AND status='closed' ORDER BY closed_at DESC,id_treatment_plan DESC"+(body.history==='all'?'':' LIMIT 1'));
        }
        let items=[];
        if(plans.length){
            replacements.plans=plans.map(p=>p.id);
            items=await query("SELECT id_patient_treatment AS id,name,id_treatment_plan AS planId FROM patient_treatment WHERE "+
                eligiblePlans+" AND id_treatment_plan IN (:plans) AND status<>'cancelled' ORDER BY name,id_patient_treatment");
        }
        return response.success({active,plans,items},'Procedimientos consultados.');
    });
}

async function canonicalSelections(form, prior, replacements, transaction) {
    const query=sql=>db.query(sql,{transaction,replacements,type:QueryTypes.SELECT});
    const ids=[...new Set([...form.done,...form.future])];
    if(!ids.length) return true;
    const stored = group=>new Map((prior?.[group] || []).map(item=>[item.id,item]));
    const done=stored('done'),future=stored('future');
    const fresh=ids.filter(id=>(form.done.includes(id) && !done.has(id)) || (form.future.includes(id) && !future.has(id)));
    const found=new Map();
    if(fresh.length) {
        replacements.ids=fresh;
        const rows=await query(`SELECT pt.id_patient_treatment AS id,pt.name,tp.status AS planStatus,tp.id_treatment_plan AS planId,tp.title AS planTitle
            FROM patient_treatment pt JOIN treatment_plan tp ON tp.id_treatment_plan=pt.id_treatment_plan AND tp.id_business=pt.id_business AND tp.id_person=pt.id_person
            WHERE pt.id_business=:business AND pt.id_person=:patient AND pt.active=1 AND pt.status<>'cancelled' AND tp.active=1
            AND (tp.status='active' OR (tp.status='closed' AND NOT EXISTS (SELECT 1 FROM treatment_plan ap WHERE ap.id_business=pt.id_business AND ap.id_person=pt.id_person AND ap.active=1 AND ap.status='active')))
            AND pt.id_patient_treatment IN (:ids)`);
        for(const item of rows) found.set(item.id,item);
    }
    for(const [group,storedItems] of [['done',done],['future',future]]) {
        const selected=[];
        for(const id of form[group]) {
            if(storedItems.has(id)){selected.push(storedItems.get(id));continue;}
            const item=found.get(id);
            if(!item || (group==='future' && item.planStatus!=='active')) return false;
            selected.push(item.planStatus==='closed' ? {id,name:item.name,planId:item.planId,planTitle:item.planTitle} : {id,name:item.name});
        }
        form[group]=selected;
    }
    return true;
}
async function list(body) {
    let request;
    try { request=listPage({page:body.page || '1',page_size:10}); } catch { return response.bad_request('Página inválida.'); }
    return db.transaction(async transaction=>{
        const access=await tracing.context(body,'tracing.create',transaction);
        if (access.error) return access.error;
        const editable = scope + ' AND NOT EXISTS (SELECT 1 FROM evolution_note_signed_version v WHERE v.id_business=:business AND v.id_person=:patient AND v.note_id=evolution_note_draft.draft_id)';
        const where=body.origin ? editable+' AND appointment_id=:origin' : editable;
        const options={replacements:{...keys(body),origin:body.origin || null},transaction,type:QueryTypes.SELECT};
        const [count]=await db.query('SELECT COUNT(*) AS total FROM evolution_note_draft WHERE '+where,options);
        const window=pageWindow(request,count.total);
        const rows=await db.query('SELECT * FROM evolution_note_draft WHERE '+where+' ORDER BY updated_at DESC,draft_id DESC LIMIT 10 OFFSET :offset',
            {...options,replacements:{...options.replacements,offset:window.offset}});
        const data=pageData(rows.map(decode),window);
        if(body.origin && !rows.length) {
            const [signed]=await db.query('SELECT d.draft_id FROM evolution_note_draft d JOIN evolution_note_signed_version v ON v.id_business=d.id_business AND v.id_person=d.id_person AND v.note_id=d.draft_id AND v.version=1 WHERE d.id_business=:business AND d.id_person=:patient AND d.author_id=:actor AND d.appointment_id=:origin',options);
            data.signedId=signed?.draft_id || null;
        }
        return response.success(data,'Borradores consultados.');
    });
}

async function save(body) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id || '') ||
        !Number.isSafeInteger(body.revision) || body.revision<0) return response.bad_request('Identificador o versión inválidos.');
    let form;
    try { form=normalize(body.form); } catch(error) { return response.bad_request(error.message); }
    return db.transaction(async transaction=>{
        await tracing.lockPatient(body,transaction);
        const access=await tracing.context(body,'tracing.create',transaction);
        if(access.error) return access.error;
        const replacements={...keys(body),id:body.id,origin:form.origin || null};
        const select=(sql)=>db.query(sql,{transaction,replacements,type:QueryTypes.SELECT});
        const [signed]=await select('SELECT version FROM evolution_note_signed_version WHERE id_business=:business AND id_person=:patient AND note_id=:id LIMIT 1');
        if(signed) return response.bad_request('La nota ya tiene firma. Consulta su historial para rectificarla.');
        const [row]=await select('SELECT * FROM evolution_note_draft WHERE '+scope+' AND draft_id=:id FOR UPDATE');
        if (row && row.revision!==body.revision && row.revision!==body.revision+1) return conflict(row);
        if (!row && body.revision) return response.notSuccess('El borrador ya no está disponible.');
        const prior=row && decode(row).form;
        if (form.origin) {
            const [visit]=await select('SELECT id_appointment FROM appointment WHERE id_business=:business AND id_person=:patient AND id_appointment=:origin AND active=1');
            if (!visit && prior?.origin!==form.origin) return response.bad_request('La cita no está disponible para este paciente.');
            const [other]=await select('SELECT * FROM evolution_note_draft WHERE '+scope+' AND appointment_id=:origin AND draft_id<>:id');
            if(other) {
                replacements.otherId=other.draft_id;
                const [closed]=await select('SELECT version FROM evolution_note_signed_version WHERE id_business=:business AND id_person=:patient AND note_id=:otherId LIMIT 1');
                if(closed) return response.bad_request('Ya firmaste una nota para esta cita. Consulta las notas con firma profesional.');
                return conflict(other);
            }
        }
        if (!await canonicalSelections(form,prior,replacements,transaction)) return response.bad_request('Un tratamiento ya no está disponible en el plan de este paciente.');
        if (row && isDeepStrictEqual(prior,form)) return response.success(decode(row),'Borrador guardado.');
        if (row && row.revision!==body.revision) return conflict(row);
        const sql=row ? 'UPDATE evolution_note_draft SET payload=:json,appointment_id=:origin,revision=revision+1,updated_at=NOW(6) WHERE '+scope+' AND draft_id=:id' :
            'INSERT INTO evolution_note_draft (id_business,id_person,author_id,draft_id,appointment_id,revision,payload) VALUES (:business,:patient,:actor,:id,:origin,1,:json)';
        await db.query(sql,{transaction,replacements:{...replacements,json:JSON.stringify(form)}});
        const [saved]=await select('SELECT * FROM evolution_note_draft WHERE '+scope+' AND draft_id=:id');
        return response.success(decode(saved),'Borrador guardado.');
    });
}
async function review(body) {
    return db.transaction(async transaction=>{
        const access=await tracing.context(body,'tracing.create',transaction);
        if(access.error) return access.error;
        const [row]=await db.query('SELECT * FROM evolution_note_draft WHERE '+scope+' AND draft_id=:id',
            {transaction,type:QueryTypes.SELECT,replacements:{...keys(body),id:body.id}});
        if(!row) return response.notSuccess('Borrador no encontrado.');
        if(row.revision!==body.revision) return conflict(row);
        const draft=decode(row);
        const f=draft.form;
        if(!complete(f))
            return response.bad_request('Completa fecha, motivo, valoración, plan y tratamiento realizado o confirma que no hubo procedimiento.');
        return response.success(draft,'Revisión del borrador guardado.');
    });
}
const complete = f => Boolean(f.date && f.reason && f.evolution && f.plan && (f.none || f.performed || f.done.length));
module.exports={procedureOptions,list,save,review,complete,canonicalSelections,normalize,decode};

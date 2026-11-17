'use strict';
const {createHash}=require('node:crypto');
const {validate:uuid}=require('uuid');
const {QueryTypes}=require('sequelize');
const {RegistrationError}=require('../registration/errors');
const {body}=require('../registration/legalRegistration.service');
const unavailable=()=>new RegistrationError('LEGAL_UNAVAILABLE',503);

class CheckoutLegalService {
    constructor(db,options={}) {
        this.db=db;
        this.env=options.env||process.env;
        this.fetch=options.fetch||global.fetch;
        this.registration=options.registration||new(require('../registration/accountLegal.service').AccountLegalService)(db);
    }
    async committedRegistration(actor) {
        if(typeof this.db?.query!=='function')return [];
        const rows=await this.db.query(`SELECT event_id,event_type,id_login,id_business,legal_error_code,legal_evidence_payload
            FROM registration_outbox WHERE id_login=:login AND id_business=:business
                AND event_type IN ('registration.created','registration.legal_updated')
                AND legal_evidence_payload IS NOT NULL AND legal_error_code IS NULL ORDER BY created_at DESC LIMIT 20`,
        {replacements:{login:actor.id_login,business:actor.id_business},type:QueryTypes.SELECT});
        return rows.flatMap(row=>{
            try {
                const value=typeof row.legal_evidence_payload==='string'?JSON.parse(row.legal_evidence_payload):row.legal_evidence_payload;
                if(!['registration.created','registration.legal_updated'].includes(row.event_type)||row.legal_error_code
                    ||row.id_login!==actor.id_login||row.id_business!==actor.id_business||!uuid(row.event_id||'')
                    ||value.subjectId!==actor.id_login||value.organizationId!==actor.id_business||value.idempotencyKey!==row.event_id
                    ||!uuid(value.snapshotToken||'')||!Number.isFinite(Date.parse(value.occurredAt))||Date.parse(value.occurredAt)>Date.now()
                    ||!Array.isArray(value.confirmations)||!value.confirmations.length||value.confirmations.length>20
                    ||new Set(value.confirmations.map(item=>item.documentVersionId)).size!==value.confirmations.length
                    ||!value.confirmations.every(item=>uuid(item.documentVersionId||'')&&/^[a-f0-9]{64}$/.test(item.contentHash||'')
                        &&['accept','acknowledge','consent'].includes(item.action)&&item.confirmed===true))return [];
                return [value];
            }catch(_){return [];}
        });
    }
    async documents(actor,prepared) {
        if(!prepared||!uuid(prepared.requestId||'')||!Number.isFinite(Date.parse(prepared.expiresAt))
            ||Date.parse(prepared.expiresAt)<=Date.now()||!Array.isArray(prepared.documents)
            ||!prepared.documents.length||prepared.documents.length>20)throw unavailable();
        const origins=String(this.env.LEGAL_DOCUMENT_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean);
        const publications=prepared.documents.map(doc=>{
            try {
                const url=new URL(doc.artifacts?.html?.url);
                if(!uuid(doc.documentId||'')||!uuid(doc.documentVersionId||'')||!/^[a-f0-9]{64}$/.test(doc.contentHash||'')
                    ||typeof doc.title!=='string'||!doc.title.trim()||url.protocol!=='https:'
                    ||url.username||url.password||url.hash||!origins.includes(url.origin))throw unavailable();
                return {doc,url};
            }catch(_){throw unavailable();}
        });
        if(new Set(publications.map(({doc})=>doc.documentId)).size!==publications.length
            ||new Set(publications.map(({doc})=>doc.documentVersionId)).size!==publications.length)throw unavailable();
        // Registration receipts inform the UI only; Proceed still creates the current verified-session checkout acceptance.
        const registered=this.registration.current(actor).catch(()=>[]);
        const [documents,registration,committed]=await Promise.all([
            Promise.all(publications.map(async({doc,url})=>{
                const html=await body(await this.fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)}),512*1024);
                if(createHash('sha256').update(html).digest('hex')!==doc.contentHash||!html.toString('utf8').trim())throw unavailable();
                return {...doc,contentHtml:html.toString('utf8')};
            })),registered,this.committedRegistration(actor).catch(()=>[])
        ]);
        if(Date.parse(prepared.expiresAt)<=Date.now())throw unavailable();
        return {...prepared,documents:documents.map(doc=>{
            const previous=Array.isArray(registration)?registration.find(item=>item.id_document==='central:'+doc.documentId
                &&item.current_version?.id_version===doc.documentVersionId&&item.current_version?.content_hash===doc.contentHash):null;
            const receipt=previous?.accepted;
            const centralAccepted=Boolean(previous?.pending===false&&receipt?.source==='central'
                &&receipt.id_version===doc.documentVersionId&&receipt.content_hash===doc.contentHash
                &&receipt.id_business===actor.id_business&&receipt.accepted_by_id===actor.id_login
                &&uuid(receipt.evidence_id||'')&&Number.isFinite(Date.parse(receipt.accepted_at)));
            // Committed review is sufficient for this UI while Legal's outbox is still being delivered.
            // It never substitutes the new verified-session checkout acceptance.
            const local=previous&&committed.find(value=>value.confirmations.some(item=>item.documentVersionId===doc.documentVersionId
                &&item.contentHash===doc.contentHash&&item.action===previous.required_action&&item.confirmed===true));
            const accepted=centralAccepted||Boolean(local);
            return {...doc,requiredAction:previous?.required_action||'accept',acceptedInRegistration:accepted,
                acceptanceSource:centralAccepted?'central':local?'registration_committed':null,
                acceptedAt:accepted?new Date(centralAccepted?receipt.accepted_at:local.occurredAt).toISOString():null};
        })};
    }
}
module.exports={CheckoutLegalService};

'use strict';
const {QueryTypes}=require('sequelize');
const {createHash}=require('node:crypto');
const {createRequire}=require('node:module');
const {LegalRegistrationService,body}=require('./legalRegistration.service');
const security=require('./registrationSecurity');
const {RegistrationError}=require('./errors');
const {validateLegalAcceptances}=require('./registration.validator');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const validDoc=d=>d&&uuid.test(d.documentId||'')&&uuid.test(d.documentVersionId||'')
    &&typeof d.documentKey==='string'&&/^\w[\w-]{0,79}$/.test(d.documentKey)
    &&typeof d.title==='string'&&typeof d.version==='string'&&/^[a-f0-9]{64}$/.test(d.contentHash||'')
    &&['accept','acknowledge','consent'].includes(d.requiredAction);
const unavailable=()=>new Error('CENTRAL_LEGAL_UNAVAILABLE');
const publicDocumentKeys={
    terms_conditions:['terms_conditions','terminos_y_condiciones'],
    privacy_notice:['privacy_notice','aviso_de_privacidad'],
};
class AccountLegalService {
    constructor(db,options={}) {this.db=db;this.legal=options.legal||new LegalRegistrationService(db,{requestTimeoutMs:20000});this.machine=options.machine||null;}
    configured() {
        return Boolean(this.legal.env.LEGAL_APPLICATION_ID?.trim());
    }
    async syncPending(actor,transaction=null) {
        const [event]=await this.db.query(`SELECT event_id FROM registration_outbox WHERE id_login=:login AND id_business=:business
            AND legal_evidence_payload IS NOT NULL AND processed_at IS NULL LIMIT 1`,
        {replacements:{login:actor.id_login,business:actor.id_business},transaction,type:QueryTypes.SELECT});
        return Boolean(event);
    }
    owner(actor) {
        if(!actor.id_session)throw new RegistrationError('LEGAL_CONTEXT_FORBIDDEN',403);
        return security.mac('legal-account-review-v1',JSON.stringify([actor.id_login,actor.id_business,actor.id_session]));
    }
    async review(actor) {
        const owner=this.owner(actor);
        const snapshot=await this.read('pending/prepare',actor);
        if(snapshot?.documentSetKey!=='registration'||!Array.isArray(snapshot.documents)
            ||!snapshot.documents.every(validDoc))throw unavailable();
        if(!snapshot.documents.length)throw new RegistrationError('LEGAL_VERSION_STALE',409);
        return this.legal.contextFromSnapshot(owner,snapshot);
    }
    async enqueue(actor,source,transaction) {
        if(!transaction)throw Error('LEGAL_TRANSACTION_REQUIRED');
        security.exact(source,['legalContext','legalAcceptances','idempotencyKey']);
        if(Buffer.byteLength(JSON.stringify(source))>8192||typeof source.legalContext!=='string'
            ||source.legalContext.length>6100||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(source.idempotencyKey||''))
            throw new RegistrationError('LEGAL_VALIDATION_FAILED');
        const input={legalContext:source.legalContext,legalAcceptances:validateLegalAcceptances(source.legalAcceptances)};
        const options={transaction,type:QueryTypes.SELECT,replacements:{id:source.idempotencyKey}};
        const [existing]=await this.db.query('SELECT * FROM registration_outbox WHERE event_id=:id LIMIT 1 FOR UPDATE',options);
        if(existing&&(existing.id_login!==actor.id_login||existing.id_business!==actor.id_business||existing.event_type!=='registration.legal_updated'))
            throw new RegistrationError('LEGAL_IDEMPOTENCY_CONFLICT',409);
        // Only a committed replay may outlive the review window; the original occurrence time is kept.
        const prepared=this.legal.prepare(input,this.owner(actor),{allowExpired:Boolean(existing)});
        if(existing) {
            const payload=typeof existing.legal_evidence_payload==='string'?JSON.parse(existing.legal_evidence_payload):existing.legal_evidence_payload;
            if(payload.snapshotToken!==prepared.snapshotToken||!Array.isArray(payload.confirmations)
                ||payload.confirmations.length!==prepared.confirmations.length||!prepared.confirmations.every((confirmation,index)=>
                    ['documentVersionId','contentHash','action','confirmed'].every(key=>payload.confirmations[index]?.[key]===confirmation[key])))
                throw new RegistrationError('LEGAL_IDEMPOTENCY_CONFLICT',409);
            return {eventId:existing.event_id,queued:!existing.processed_at,evidenceId:existing.legal_evidence_id||null};
        }
        if(await this.syncPending(actor,transaction))throw new RegistrationError('LEGAL_SYNC_PENDING',409);
        const payload={...prepared,idempotencyKey:source.idempotencyKey,subjectId:actor.id_login,organizationId:actor.id_business};
        await this.db.query(`INSERT INTO registration_outbox(event_id,attempt_id,event_type,id_login,id_business,created_at,legal_evidence_payload)
            VALUES(:id,:id,'registration.legal_updated',:login,:business,UTC_TIMESTAMP(3),:payload)`,
        {transaction,type:QueryTypes.INSERT,replacements:{id:source.idempotencyKey,login:actor.id_login,business:actor.id_business,payload:JSON.stringify(payload)}});
        return {eventId:source.idempotencyKey,queued:true,evidenceId:null};
    }
    async read(route,actor,cursor) {
        const config=this.legal.configuration();
        if(!this.machine) {
            // Reuse the installed public MachineClient used by @hemia/legal 0.1.
            const {MachineClient}=createRequire(require.resolve('@hemia/legal'))('@hemia/auth');
            this.machine=new MachineClient({issuer:config.issuer.href,tokenUrl:new URL('/oauth/token',config.issuer).href,
                clientId:config.clientId,clientSecret:config.secret,allowHttpLoopback:process.env.NODE_ENV!=='production',requestTimeoutMs:20000,
                destinations:{legalRead:{baseUrl:config.base.origin,audience:'legal-api',resource:config.base.origin,scopes:['legal.integration.acceptances.prepare']}}});
        }
        const response=await this.machine.request('legalRead','v1/legal/integrations/'+route,{method:'POST',
            headers:{accept:'application/json','content-type':'application/json'},
            body:JSON.stringify({applicationId:config.applicationId,documentSetKey:'registration',subjectId:actor.id_login,
                organizationId:actor.id_business,locale:'es-MX',...(cursor?{cursor}:{})})});
        return JSON.parse((await body(response,2*1024*1024)).toString('utf8'));
    }
    async history(actor,cursor) {
        if(cursor&&!uuid.test(cursor))throw unavailable();
        const value=await this.read('evidence/history',actor,cursor);
        if(!Array.isArray(value.items)||value.items.length>100||(value.nextCursor!==null&&!uuid.test(value.nextCursor||'')))throw unavailable();
        for(const item of value.items) {
            if(!uuid.test(item.evidenceId||'')||item.recorded!==true||!Number.isFinite(Date.parse(item.occurredAt))
                ||!Array.isArray(item.documents)||item.documents.length>100||!item.documents.every(validDoc)
                ||!Array.isArray(item.confirmations)||!item.documents.every(d=>item.confirmations.some(c=>c.documentVersionId===d.documentVersionId
                    &&c.contentHash===d.contentHash&&c.action===d.requiredAction&&c.confirmed===true)))throw unavailable();
        }
        return value;
    }
    async pending(actor) {
        const value=await this.read('pending/evaluate',actor);
        if(value.documentSetKey!=='registration'||!Array.isArray(value.pendingDocuments)
            ||!value.pendingDocuments.every(validDoc))throw unavailable();
        return value;
    }
    receipt(item,doc,actor) {
        return {id_acceptance:'central:'+item.evidenceId+':'+doc.documentVersionId,id_version:doc.documentVersionId,
            id_document:'central:'+doc.documentId,document_key:doc.documentKey,title:doc.title,version_number:doc.version,
            id_business:actor.id_business,acceptance_scope:'user',accepted_at:item.occurredAt,accepted_by_id:actor.id_login,
            accepted_by_name:actor.name,content_hash:doc.contentHash,source:'central',evidence_id:item.evidenceId,
            action:doc.requiredAction,version:{id_version:doc.documentVersionId,version_number:doc.version,title:doc.title,
                content_hash:doc.contentHash,content_html:'',acceptance_scope:'user',source:'central'}};
    }
    async current(actor) {
        const config=this.legal.configuration();
        const snapshot=await this.legal.legalClient(config).getDocumentSet({applicationId:config.applicationId,documentSetKey:'registration',locale:'es-MX'});
        const pending=await this.pending(actor);
        if(pending.revision!==snapshot.revision||!snapshot.documents.every(validDoc)
            ||!pending.pendingDocuments.every(p=>snapshot.documents.some(d=>d.documentId===p.documentId
                &&d.documentVersionId===p.documentVersionId&&d.contentHash===p.contentHash&&d.requiredAction===p.requiredAction)))throw unavailable();
        const history=await this.history(actor);
        return snapshot.documents.map(doc=>{
            const item=history.items.find(item=>item.documents.some(d=>d.documentId===doc.documentId&&d.documentVersionId===doc.documentVersionId
                &&d.contentHash===doc.contentHash&&d.requiredAction===doc.requiredAction));
            const needsReview=pending.pendingDocuments.some(d=>d.documentId===doc.documentId);
            return {id_document:'central:'+doc.documentId,document_key:doc.documentKey,title:doc.title,acceptance_scope:'user',
                description:'Documento de registro administrado en Legal central.',required:true,source:'central',
                current_version:{id_version:doc.documentVersionId,version_number:doc.version,title:doc.title,content_hash:doc.contentHash,
                    content_html:'',acceptance_scope:'user',source:'central'},
                accepted:!needsReview&&item?this.receipt(item,doc,actor):null,can_accept:false,pending:needsReview};
        });
    }
    async document(actor,versionId,cursor) {
        if(!uuid.test(versionId||''))throw unavailable();
        const config=this.legal.configuration();
        const history=await this.history(actor,cursor);
        let doc=history.items.flatMap(item=>item.documents).find(d=>d.documentVersionId===versionId);
        if(!doc) {
            const snapshot=await this.legal.legalClient(config).getDocumentSet({applicationId:config.applicationId,documentSetKey:'registration',locale:'es-MX'});
            doc=snapshot.documents.find(d=>d.documentVersionId===versionId);
        }
        if(!doc||!validDoc(doc))throw unavailable();
        return this.publishedVersion(config,doc);
    }
    async publicCurrent(key) {
        const config=this.legal.configuration();
        const snapshot=await this.legal.legalClient(config).getDocumentSet({applicationId:config.applicationId,documentSetKey:'registration',locale:'es-MX'});
        const keys=publicDocumentKeys[key];
        const matches=snapshot.documents.filter(doc=>keys.includes(doc.documentKey));
        if(!matches.length)return null;
        if(matches.length!==1||!validDoc(matches[0]))throw unavailable();
        const [doc]=matches;
        const version=await this.publishedVersion(config,doc);
        return {id_document:doc.documentId,document_key:key,title:doc.title,
            description:version.description,current_version:version};
    }
    async publishedVersion(config,doc) {
        const url=new URL(`v1/legal/public/${config.applicationId}/documents/${encodeURIComponent(doc.documentKey)}/versions/${encodeURIComponent(doc.version)}?locale=es-MX`,config.base.origin);
        const published=JSON.parse((await body(await this.legal.fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)}),1024*1024)).toString('utf8'));
        if(published.version?.id!==doc.documentVersionId||published.document?.id!==doc.documentId||published.contentHash!==doc.contentHash)throw unavailable();
        const artifact=new URL(published.artifacts?.html?.url);
        const origins=(this.legal.env.LEGAL_DOCUMENT_ORIGINS||'').split(',').map(v=>v.trim());
        if(artifact.protocol!=='https:'||artifact.username||artifact.password||!origins.includes(artifact.origin))throw unavailable();
        const html=await body(await this.legal.fetch(artifact,{redirect:'error',signal:AbortSignal.timeout(8000)}),512*1024);
        if(createHash('sha256').update(html).digest('hex')!==doc.contentHash)throw unavailable();
        return {id_version:doc.documentVersionId,version_number:doc.version,title:doc.title,content_hash:doc.contentHash,
            description:typeof published.document.description==='string'?published.document.description:'',
            content_html:html.toString('utf8'),source:'central',acceptance_scope:'user',published_at:published.version.publishedAt||null};
    }
}
module.exports={AccountLegalService};

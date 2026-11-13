'use strict';
const {QueryTypes}=require('sequelize');
const {createHash}=require('node:crypto');
const {createRequire}=require('node:module');
const {LegalRegistrationService,body,endpoint}=require('./legalRegistration.service');
const security=require('./registrationSecurity');
const {RegistrationError}=require('./errors');
const {validateLegalAcceptances}=require('./registration.validator');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const validDoc=d=>d&&uuid.test(d.documentId||'')&&uuid.test(d.documentVersionId||'')
    &&typeof d.documentKey==='string'&&/^\w[\w-]{0,79}$/.test(d.documentKey)
    &&typeof d.title==='string'&&typeof d.version==='string'&&/^[a-f0-9]{64}$/.test(d.contentHash||'')
    &&['accept','acknowledge','consent'].includes(d.requiredAction);
const unavailable=()=>new Error('CENTRAL_LEGAL_UNAVAILABLE');
const registration='registration';
const setKeyPattern=/^[a-z][a-z0-9_-]{1,79}$/;
const canRepresent=actor=>['admin','business_admin'].includes(actor.role);
const publicDocumentKeys={
    terms_conditions:['terms_conditions','terminos_y_condiciones'],
    privacy_notice:['privacy_notice','aviso_de_privacidad'],
};
class AccountLegalService {
    constructor(db,options={}) {this.db=db;this.legal=options.legal||new LegalRegistrationService(db,{requestTimeoutMs:20000});this.machine=options.machine||null;}
    configured() {
        return Boolean(this.legal.env.LEGAL_APPLICATION_ID?.trim());
    }
    catalogEnabled() { return this.legal.env.LEGAL_ACCOUNT_CATALOG_ENABLED==='true'; }
    async authorizeContext(authorization) {
        const token=/^Bearer ([^\s]{1,8192})$/i.exec(authorization||'')?.[1];
        const env=this.legal.env;
        if(!this.catalogEnabled()||!token||!env.LEGAL_CONTEXT_CALLER_ID||!env.LEGAL_CONTEXT_AUDIENCE||!env.LEGAL_CONTEXT_INTROSPECTION_URL)return false;
        const config=this.legal.configuration();
        const url=endpoint(env.LEGAL_CONTEXT_INTROSPECTION_URL);
        if(url.origin!==config.issuer.origin)throw unavailable();
        const reply=await this.legal.fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),
            headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.secret,token})});
        const claims=JSON.parse((await body(reply,16384)).toString('utf8'));
        return claims?.active===true&&typeof claims.exp==='number'&&claims.exp>Date.now()/1000&&claims.aud===env.LEGAL_CONTEXT_AUDIENCE
            &&claims.client_id===env.LEGAL_CONTEXT_CALLER_ID&&!Object.hasOwn(claims,'sub')&&!Object.hasOwn(claims,'session_id')
            &&typeof claims.scope==='string'&&claims.scope.split(/\s+/).includes('legal.consumer_context.read');
    }
    async accountSets(actor) {
        if(!this.catalogEnabled())return [];
        const value=await this.read('account-catalog',actor,null,null);
        if(!Array.isArray(value?.sets)||new Set(value.sets.map(set=>set?.documentSetKey)).size!==value.sets.length
            ||!value.sets.every(set=>typeof set?.documentSetKey==='string'&&setKeyPattern.test(set.documentSetKey)&&set.documentSetKey!==registration
                &&uuid.test(set.revision||'')&&typeof set.name==='string'&&['individual','organization'].includes(set.evidenceScope)
                &&['collector_attested','verified_session'].includes(set.verification)
                &&Array.isArray(set.documents)&&set.documents.length<=100&&set.documents.every(doc=>
                    validDoc(doc)||doc?.requiredAction==='informational'&&validDoc({...doc,requiredAction:'acknowledge'}))))throw unavailable();
        return value.sets;
    }
    async accountSet(actor,key) {
        if(key===registration)return {documentSetKey:registration,evidenceScope:'individual'};
        if(typeof key!=='string'||!setKeyPattern.test(key))throw new RegistrationError('LEGAL_CONTEXT_FORBIDDEN',403);
        const set=(await this.accountSets(actor)).find(set=>set.documentSetKey===key);
        if(!set)throw new RegistrationError('LEGAL_CONTEXT_FORBIDDEN',403);
        return set;
    }
    async syncPending(actor,transaction=null) {
        const [event]=await this.db.query(`SELECT event_id FROM registration_outbox WHERE id_login=:login AND id_business=:business
            AND legal_evidence_payload IS NOT NULL AND processed_at IS NULL
            AND (legal_error_code IS NULL OR legal_error_code<>'LEGAL_REPRESENTATIVE_REJECTED') LIMIT 1`,
        {replacements:{login:actor.id_login,business:actor.id_business},transaction,type:QueryTypes.SELECT});
        return Boolean(event);
    }
    owner(actor,key=registration) {
        if(!actor.id_session)throw new RegistrationError('LEGAL_CONTEXT_FORBIDDEN',403);
        return security.mac('legal-account-review-v1',JSON.stringify(key===registration
            ? [actor.id_login,actor.id_business,actor.id_session] : [actor.id_login,actor.id_business,actor.id_session,key]));
    }
    async review(actor,key=registration) {
        const owner=this.owner(actor,key);
        const set=await this.accountSet(actor,key);
        const organization=set.evidenceScope==='organization';
        if(organization&&!canRepresent(actor))throw new RegistrationError('LEGAL_CONTEXT_FORBIDDEN',403);
        const snapshot=await this.read('pending/prepare',actor,null,key,organization||set.verification==='verified_session');
        if(snapshot?.documentSetKey!==key||!Array.isArray(snapshot.documents)
            ||!snapshot.documents.every(validDoc))throw unavailable();
        if(!snapshot.documents.length)throw new RegistrationError('LEGAL_VERSION_STALE',409);
        return {...await this.legal.contextFromSnapshot(owner,snapshot),acceptanceScope:organization?'business':'user'};
    }
    async enqueue(actor,source,transaction) {
        if(!transaction)throw Error('LEGAL_TRANSACTION_REQUIRED');
        security.exact(source,['legalContext','legalAcceptances','idempotencyKey',...(source?.documentSetKey===undefined?[]:['documentSetKey'])]);
        const key=source.documentSetKey===undefined?registration:source.documentSetKey;
        if(typeof key!=='string'||!setKeyPattern.test(key))throw new RegistrationError('LEGAL_VALIDATION_FAILED');
        if(Buffer.byteLength(JSON.stringify(source))>8192||typeof source.legalContext!=='string'
            ||source.legalContext.length>6100||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(source.idempotencyKey||''))
            throw new RegistrationError('LEGAL_VALIDATION_FAILED');
        const input={legalContext:source.legalContext,legalAcceptances:validateLegalAcceptances(source.legalAcceptances)};
        const options={transaction,type:QueryTypes.SELECT,replacements:{id:source.idempotencyKey}};
        const [existing]=await this.db.query('SELECT * FROM registration_outbox WHERE event_id=:id LIMIT 1 FOR UPDATE',options);
        if(existing&&(existing.id_login!==actor.id_login||existing.id_business!==actor.id_business||existing.event_type!=='registration.legal_updated'))
            throw new RegistrationError('LEGAL_IDEMPOTENCY_CONFLICT',409);
        // Only a committed replay may outlive the review window; the original occurrence time is kept.
        const prepared=this.legal.prepare(input,this.owner(actor,key),{allowExpired:Boolean(existing)});
        if(existing) {
            const payload=typeof existing.legal_evidence_payload==='string'?JSON.parse(existing.legal_evidence_payload):existing.legal_evidence_payload;
            if(payload.snapshotToken!==prepared.snapshotToken||!Array.isArray(payload.confirmations)
                ||payload.confirmations.length!==prepared.confirmations.length||!prepared.confirmations.every((confirmation,index)=>
                    ['documentVersionId','contentHash','action','confirmed'].every(key=>payload.confirmations[index]?.[key]===confirmation[key])))
                throw new RegistrationError('LEGAL_IDEMPOTENCY_CONFLICT',409);
            if(existing.legal_error_code==='LEGAL_REPRESENTATIVE_REJECTED')throw new RegistrationError('LEGAL_REPRESENTATIVE_REJECTED',409);
            return {eventId:existing.event_id,queued:!existing.processed_at,evidenceId:existing.legal_evidence_id||null};
        }
        const set=await this.accountSet(actor,key);
        const organization=set.evidenceScope==='organization';
        if(organization&&!canRepresent(actor))throw new RegistrationError('LEGAL_CONTEXT_FORBIDDEN',403);
        if(await this.syncPending(actor,transaction))throw new RegistrationError('LEGAL_SYNC_PENDING',409);
        const payload={...prepared,idempotencyKey:source.idempotencyKey,subjectId:actor.id_login,organizationId:actor.id_business,
            ...(organization||set.verification==='verified_session'?{sessionId:actor.id_session}:{})};
        await this.db.query(`INSERT INTO registration_outbox(event_id,attempt_id,event_type,id_login,id_business,created_at,legal_evidence_payload)
            VALUES(:id,:id,'registration.legal_updated',:login,:business,UTC_TIMESTAMP(3),:payload)`,
        {transaction,type:QueryTypes.INSERT,replacements:{id:source.idempotencyKey,login:actor.id_login,business:actor.id_business,payload:JSON.stringify(payload)}});
        return {eventId:source.idempotencyKey,queued:true,evidenceId:null};
    }
    async read(route,actor,cursor,key=registration,withSession=false,documentVersionId) {
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
            body:JSON.stringify({applicationId:config.applicationId,...(key?{documentSetKey:key}:{}),subjectId:actor.id_login,
                organizationId:actor.id_business,locale:'es-MX',...(cursor?{cursor}:{}),...(withSession?{sessionId:actor.id_session}:{}),
                ...(documentVersionId?{documentVersionId}:{})})});
        return JSON.parse((await body(response,2*1024*1024)).toString('utf8'));
    }
    async history(actor,cursor,key=registration) {
        if(cursor&&!uuid.test(cursor))throw unavailable();
        const value=await this.read('evidence/history',actor,cursor,key);
        if(!Array.isArray(value.items)||value.items.length>100||(value.nextCursor!==null&&!uuid.test(value.nextCursor||'')))throw unavailable();
        for(const item of value.items) {
            if(!uuid.test(item.evidenceId||'')||item.recorded!==true||!Number.isFinite(Date.parse(item.occurredAt))
                ||!Array.isArray(item.documents)||item.documents.length>100||!item.documents.every(validDoc)
                ||!Array.isArray(item.confirmations)||!item.documents.every(d=>item.confirmations.some(c=>c.documentVersionId===d.documentVersionId
                    &&c.contentHash===d.contentHash&&c.action===d.requiredAction&&c.confirmed===true)))throw unavailable();
        }
        return value;
    }
    async pending(actor,key=registration) {
        const value=await this.read('pending/evaluate',actor,null,key);
        if(value.documentSetKey!==key||!Array.isArray(value.pendingDocuments)
            ||!value.pendingDocuments.every(validDoc))throw unavailable();
        return value;
    }
    async notice(actor) {
        const personal=await this.pending(actor);
        const sets=await this.accountSets(actor);
        const pending=await Promise.all(sets.map(set=>this.pending(actor,set.documentSetKey)));
        return {count:personal.pendingDocuments.length+pending.reduce((sum,result)=>sum+result.pendingDocuments.length,0),
            businessPending:pending.some((result,index)=>sets[index].evidenceScope==='organization'&&result.pendingDocuments.length>0)};
    }
    receipt(item,doc,actor,set) {
        const scope=set?.evidenceScope==='organization'?'business':'user';
        const signer=scope==='business'?item.signerSubjectId:actor.id_login;
        return {id_acceptance:'central:'+item.evidenceId+':'+doc.documentVersionId,id_version:doc.documentVersionId,
            id_document:'central:'+doc.documentId,document_key:doc.documentKey,title:doc.title,version_number:doc.version,
            id_business:actor.id_business,acceptance_scope:scope,accepted_at:item.occurredAt,accepted_by_id:signer,
            accepted_by_name:signer===actor.id_login?actor.name:item.signerName,content_hash:doc.contentHash,source:'central',evidence_id:item.evidenceId,
            action:doc.requiredAction,version:{id_version:doc.documentVersionId,version_number:doc.version,title:doc.title,
                content_hash:doc.contentHash,content_html:'',acceptance_scope:scope,source:'central'}};
    }
    async setHistory(actor,set,cursor) {
        const history=await this.history(actor,cursor,set.documentSetKey);
        if(set.evidenceScope!=='organization'||!history.items.length)return history;
        if(!history.items.every(item=>typeof item.signerSubjectId==='string'&&item.signerSubjectId.length>0&&item.signerSubjectId.length<=160))throw unavailable();
        const ids=[...new Set(history.items.map(item=>item.signerSubjectId))];
        const names=await this.db.query('SELECT id_login,name FROM login WHERE id_business=:business AND id_login IN (:ids)',
            {replacements:{business:actor.id_business,ids},type:QueryTypes.SELECT});
        const byId=new Map(names.map(row=>[row.id_login,row.name]));
        return {...history,items:history.items.map(item=>({...item,signerName:byId.get(item.signerSubjectId)}))};
    }
    async accountHistory(actor,cursor) {
        const sets=[{documentSetKey:registration,evidenceScope:'individual'},...await this.accountSets(actor)];
        let offsets=null;
        if(cursor&&uuid.test(cursor)) offsets={[registration]:cursor};
        else if(cursor){
            if(typeof cursor!=='string'||cursor.length>17000||!/^v1\.[A-Za-z0-9_-]+$/.test(cursor))throw unavailable();
            offsets=JSON.parse(Buffer.from(cursor.slice(3),'base64url').toString('utf8'));
            if(!offsets||Array.isArray(offsets)||typeof offsets!=='object'||!Object.entries(offsets).every(([key,id])=>setKeyPattern.test(key)&&uuid.test(id)))throw unavailable();
        }
        const items=[],next=Object.create(null);
        for(const set of sets){
            const key=set.documentSetKey;
            if(offsets&&!Object.hasOwn(offsets,key))continue;
            const offset=offsets?.[key];
            const history=await this.setHistory(actor,set,offset);
            for(const item of history.items)for(const doc of item.documents)items.push({...this.receipt(item,doc,actor,set),
                document_set_key:key,history_cursor:offset||null});
            if(history.nextCursor)next[key]=history.nextCursor;
        }
        const keys=Object.keys(next);
        return {items,nextCursor:!keys.length?null:keys.length===1&&next[registration]?next[registration]:
            'v1.'+Buffer.from(JSON.stringify(next)).toString('base64url')};
    }
    async current(actor) {
        const config=this.legal.configuration();
        const snapshot=await this.legal.legalClient(config).getDocumentSet({applicationId:config.applicationId,documentSetKey:'registration',locale:'es-MX'});
        const pending=await this.pending(actor);
        if(pending.revision!==snapshot.revision||!snapshot.documents.every(validDoc)
            ||!pending.pendingDocuments.every(p=>snapshot.documents.some(d=>d.documentId===p.documentId
                &&d.documentVersionId===p.documentVersionId&&d.contentHash===p.contentHash&&d.requiredAction===p.requiredAction)))throw unavailable();
        const history=await this.history(actor);
        const personal=this.describe(actor,{documentSetKey:registration,evidenceScope:'individual',documents:snapshot.documents},pending,history);
        const sets=await this.accountSets(actor);
        const extra=await Promise.all(sets.map(async set=>{
            const [pending,history]=await Promise.all([this.pending(actor,set.documentSetKey),this.setHistory(actor,set)]);
            if(pending.revision!==set.revision||!pending.pendingDocuments.every(p=>set.documents.some(d=>d.documentVersionId===p.documentVersionId&&d.contentHash===p.contentHash)))throw unavailable();
            return this.describe(actor,set,pending,history);
        }));
        return personal.concat(extra.flat());
    }
    describe(actor,set,pending,history) {
        const scope=set.evidenceScope==='organization'?'business':'user';
        return set.documents.map(doc=>{
            const item=history.items.find(item=>item.documents.some(d=>d.documentId===doc.documentId&&d.documentVersionId===doc.documentVersionId
                &&d.contentHash===doc.contentHash&&d.requiredAction===doc.requiredAction));
            const needsReview=pending.pendingDocuments.some(d=>d.documentId===doc.documentId);
            const informational=doc.requiredAction==='informational';
            return {id_document:'central:'+doc.documentId+(set.documentSetKey===registration?'':':'+set.documentSetKey),document_key:doc.documentKey,title:doc.title,acceptance_scope:scope,
                document_set_key:set.documentSetKey,document_set_name:set.name,informational,central_can_review:!informational&&(scope==='user'||canRepresent(actor)),
                required:!informational,source:'central',
                current_version:{id_version:doc.documentVersionId,version_number:doc.version,title:doc.title,content_hash:doc.contentHash,
                    content_html:'',acceptance_scope:scope,source:'central'},
                accepted:!needsReview&&item?this.receipt(item,doc,actor,set):null,can_accept:false,pending:needsReview};
        });
    }
    async document(actor,versionId,cursor,key=registration) {
        if(!uuid.test(versionId||''))throw unavailable();
        const config=this.legal.configuration();
        const set=await this.accountSet(actor,key);
        const history=await this.history(actor,cursor,key);
        let doc=history.items.flatMap(item=>item.documents).find(d=>d.documentVersionId===versionId);
        if(!doc) {
            const snapshot=key===registration?await this.legal.legalClient(config).getDocumentSet({applicationId:config.applicationId,documentSetKey:key,locale:'es-MX'}):set;
            doc=snapshot.documents.find(d=>d.documentVersionId===versionId);
        }
        if(!doc||!validDoc(doc)&&!(doc.requiredAction==='informational'&&validDoc({...doc,requiredAction:'acknowledge'})))throw unavailable();
        const published=key===registration?undefined:await this.read('account-document',actor,cursor,key,false,versionId);
        if(key!==registration&&!published)throw unavailable();
        return {...await this.publishedVersion(config,doc,published),acceptance_scope:set.evidenceScope==='organization'?'business':'user'};
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
    async publishedVersion(config,doc,published) {
        const url=new URL(`v1/legal/public/${config.applicationId}/documents/${encodeURIComponent(doc.documentKey)}/versions/${encodeURIComponent(doc.version)}?locale=es-MX`,config.base.origin);
        published??=JSON.parse((await body(await this.legal.fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)}),1024*1024)).toString('utf8'));
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
module.exports={AccountLegalService,canRepresent,setKeyPattern};

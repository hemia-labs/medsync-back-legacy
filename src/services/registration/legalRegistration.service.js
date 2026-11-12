'use strict';
const {createHash,randomUUID}=require('node:crypto');
const {QueryTypes}=require('sequelize');
const {RegistrationError}=require('./errors');
const security=require('./registrationSecurity');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const unavailable=()=>new RegistrationError('LEGAL_UNAVAILABLE',503);

function endpoint(value) {
    const url=new URL(value);
    if(url.username||url.password||url.search||url.hash
        ||(url.protocol!=='https:' && !(process.env.NODE_ENV!=='production' && url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw unavailable();
    return url;
}
async function body(response,limit) {
    if(!response.ok||Number(response.headers.get('content-length'))>limit||!response.body) throw unavailable();
    const chunks=[];let size=0;
    for await(const chunk of response.body) {size+=chunk.length;if(size>limit){throw unavailable();}chunks.push(chunk);}
    return Buffer.concat(chunks);
}
class LegalRegistrationService {
    constructor(database,options={}) {
        this.db=database;this.fetch=options.fetch||global.fetch;this.clock=options.clock||Date.now;
        this.env=options.env||process.env;this.client=null;this.running=false;
        this.requestTimeoutMs=options.requestTimeoutMs??8000;
    }
    configuration() {
        const env=this.env,base=endpoint(env.LEGAL_API_URL),issuer=endpoint(env.HEMIA_ID_URL);
        if(!uuid.test(env.LEGAL_APPLICATION_ID||'')||!env.HEMIA_CLIENT_ID||!env.HEMIA_CLIENT_SECRET) throw unavailable();
        return {base,issuer,applicationId:env.LEGAL_APPLICATION_ID,clientId:env.HEMIA_CLIENT_ID,secret:env.HEMIA_CLIENT_SECRET};
    }
    legalClient(config) {
        if(!this.client) {
            try {
                const {createLegalClient}=require('@hemia/legal');
                this.client=createLegalClient({
                    baseUrl:config.base.origin,
                    requestTimeoutMs:this.requestTimeoutMs,
                    allowHttpLoopback:process.env.NODE_ENV!=='production',
                    auth:{
                        issuer:config.issuer.href,
                        tokenUrl:new URL('/oauth/token',config.issuer).href,
                        clientId:config.clientId,
                        clientSecret:config.secret,
                    },
                });
            } catch(_) {throw unavailable();}
        }
        return this.client;
    }
    async ready() {
        this.legalClient(this.configuration());
        await this.db.query('SELECT legal_evidence_payload,legal_evidence_id FROM registration_outbox LIMIT 0',{type:QueryTypes.SELECT});
    }
    async context(attemptSecret) {
        const config=this.configuration();
        let snapshot;
        try {
            snapshot=await this.legalClient(config).getDocumentSet({
                applicationId:config.applicationId,documentSetKey:'registration',locale:'es-MX',
            });
        } catch(_) {throw unavailable();}
        return this.contextFromSnapshot(attemptSecret,snapshot);
    }
    async contextFromSnapshot(attemptSecret,snapshot) {
        if(!uuid.test(snapshot.snapshotToken||'')||!Number.isFinite(Date.parse(snapshot.expiresAt))
            ||Date.parse(snapshot.expiresAt)<=this.clock()||!Array.isArray(snapshot.documents)||!snapshot.documents.length||snapshot.documents.length>10) throw unavailable();
        const origins=(this.env.LEGAL_DOCUMENT_ORIGINS||'').split(',').map(v=>v.trim()).filter(Boolean);
        const publications=snapshot.documents.map(d=>{
            if(!/^\w[\w-]{0,79}$/.test(d.documentKey)||!uuid.test(d.documentVersionId||'')
                ||!['accept','acknowledge','consent'].includes(d.requiredAction)||!d.artifacts?.html?.url) throw unavailable();
            const url=new URL(d.artifacts.html.url);
            if(url.protocol!=='https:'||url.username||url.password||!origins.includes(url.origin)) throw unavailable();
            return {d,url};
        });
        if(new Set(snapshot.documents.map(d=>d.documentKey)).size!==publications.length
            ||new Set(snapshot.documents.map(d=>d.documentVersionId)).size!==publications.length) throw unavailable();
        const documents=await Promise.all(publications.map(async({d,url})=>{
            const html=await body(await this.fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)}),512*1024);
            if(createHash('sha256').update(html).digest('hex')!==d.contentHash) throw unavailable();
            return {documentKey:d.documentKey,versionId:d.documentVersionId,version:d.version,title:d.title,contentHash:d.contentHash,requiredAction:d.requiredAction,contentHtml:html.toString('utf8')};
        }));
        const evidence={snapshotToken:snapshot.snapshotToken,expiresAt:snapshot.expiresAt,owner:security.mac('legal-owner-v1',attemptSecret),
            documents:documents.map(({documentKey,versionId,contentHash,requiredAction})=>({documentKey,versionId,contentHash,requiredAction}))};
        const encoded=Buffer.from(JSON.stringify(evidence)).toString('base64url');
        return {legalContext:encoded+'.'+security.mac('legal-context-v1',encoded),legalSnapshotToken:snapshot.snapshotToken,legalContextExpiresAt:snapshot.expiresAt,legalDocuments:documents};
    }
    prepare(input,attemptSecret,{allowExpired=false}={}) {
        try {
            const [encoded,signature,extra]=String(input.legalContext||'').split('.');
            if(extra||!encoded||encoded.length>6000||!security.equal(signature,security.mac('legal-context-v1',encoded))) throw Error();
            const value=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
            if(!uuid.test(value.snapshotToken)||!security.equal(value.owner,security.mac('legal-owner-v1',attemptSecret))
                ||!Number.isFinite(Date.parse(value.expiresAt))||(!allowExpired&&Date.parse(value.expiresAt)<=this.clock())
                ||!Array.isArray(value.documents)||value.documents.length!==input.legalAcceptances.length
                ||!value.documents.every(d=>input.legalAcceptances.some(a=>a.documentKey===d.documentKey&&a.versionId===d.versionId&&a.acknowledged===true))) throw Error();
            return {snapshotToken:value.snapshotToken,occurredAt:new Date(this.clock()).toISOString(),
                confirmations:value.documents.map(d=>({documentVersionId:d.versionId,contentHash:d.contentHash,action:d.requiredAction,confirmed:true}))};
        } catch(_) {throw new RegistrationError('LEGAL_VERSION_STALE',409);}
    }
    async deliver(event) {
        const client=this.legalClient(this.configuration());
        const payload=typeof event.legal_evidence_payload==='string'?JSON.parse(event.legal_evidence_payload):event.legal_evidence_payload;
        try {
            return await client.recordEvidence(payload);
        } catch(error) {
            if(error.status===401 && this.client===client) this.client=null;
            if(error.code==='http') throw new RegistrationError('LEGAL_HTTP_'+error.status,error.status);
            throw unavailable();
        }
    }
    async flush(limit=5) {
        if(this.running)return;this.running=true;
        try {
            for(let i=0;i<limit;i++) {
                const event=await this.db.transaction(async transaction=>{
                    const rows=await this.db.query(`SELECT * FROM registration_outbox WHERE legal_evidence_payload IS NOT NULL AND processed_at IS NULL
                        AND (legal_error_code IS NULL OR legal_error_code<>'LEGAL_REPRESENTATIVE_REJECTED')
                        AND (legal_retry_at IS NULL OR legal_retry_at<=UTC_TIMESTAMP(3)) AND (legal_lease_until IS NULL OR legal_lease_until<=UTC_TIMESTAMP(3))
                        ORDER BY created_at LIMIT 1 FOR UPDATE`,{transaction,type:QueryTypes.SELECT});
                    if(!rows[0])return null;
                    const event=rows[0];event.leaseId=randomUUID();
                    await this.db.query(`UPDATE registration_outbox SET legal_lease_id=:lease,legal_lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 60 SECOND),legal_attempts=legal_attempts+1 WHERE event_id=:id`,
                        {replacements:{lease:event.leaseId,id:event.event_id},transaction,type:QueryTypes.UPDATE});return event;
                });
                if(!event)break;
                try {
                    const receipt=await this.deliver(event);
                    await this.db.query(`UPDATE registration_outbox SET legal_evidence_id=:evidence,processed_at=UTC_TIMESTAMP(3),legal_error_code=NULL,legal_lease_id=NULL,legal_lease_until=NULL
                        WHERE event_id=:id AND legal_lease_id=:lease`,{replacements:{evidence:receipt.evidenceId,id:event.event_id,lease:event.leaseId},type:QueryTypes.UPDATE});
                }catch(error) {
                    const payload=error.code==='LEGAL_HTTP_403' && (typeof event.legal_evidence_payload==='string'
                        ? JSON.parse(event.legal_evidence_payload) : event.legal_evidence_payload);
                    const rejected=event.event_type==='registration.legal_updated'&&payload?.sessionId;
                    const delay=Math.min(3600,15*2**Math.min(8,Number(event.legal_attempts)||0));
                    await this.db.query(`UPDATE registration_outbox SET legal_error_code=:code,legal_retry_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL :delay SECOND),legal_lease_id=NULL,legal_lease_until=NULL
                        WHERE event_id=:id AND legal_lease_id=:lease`,{replacements:{code:rejected?'LEGAL_REPRESENTATIVE_REJECTED':/^LEGAL_[A-Z0-9_]{1,40}$/.test(error.code||'')?error.code:'LEGAL_UNAVAILABLE',delay,id:event.event_id,lease:event.leaseId},type:QueryTypes.UPDATE});
                }
            }
        }finally{this.running=false;}
    }
}
function startLegalEvidenceJob(database) {
    const service=new LegalRegistrationService(database);
    const tick=()=>service.ready().then(()=>service.flush()).catch(()=>{});
    const timer=setInterval(tick,15000);timer.unref();tick();return timer;
}
module.exports={LegalRegistrationService,startLegalEvidenceJob,endpoint,body};

'use strict';
// Real HTTP, authentication, CSRF and transactions against disposable MySQL; synthetic Legal only.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {QueryTypes}=require('sequelize');
const express=require('express'),cookies=require('cookie-parser');
async function run(){
    process.env.REGISTRATION_HMAC_KEY='73'.repeat(32);
    Object.assign(process.env,{NODE_ENV:'test',APP_ENV:'test',AUTH_COOKIE_MODE:'d2',BROWSER_AUTH_TRANSPORT:'cookie',AUTH_COOKIE_SECURE:'false',
        AUTH_COOKIE_DOMAIN:'',AUTH_COOKIE_PATH:'/',AUTH_COOKIE_ACCESS_NAME:'legal_qa_at',AUTH_COOKIE_REFRESH_NAME:'legal_qa_rt',
        AUTH_CSRF_COOKIE_NAME:'legal_qa_csrf',CSRF_COOKIE_NAME:'legal_qa_csrf',AUTH_COOKIE_SAMESITE:'lax',CSRF_ENABLED:'true',
        CSRF_ORIGIN_CHECK_ENABLED:'true',CORS_CREDENTIALS:'true',JWT_SECRET:'synthetic-legal-qa',CSRF_TOKEN_SECRET:'synthetic-legal-qa-secret-long-enough-123456'});
    const fixture=await require('./registration-http-fixture').createFixture(),{db,legal}=fixture;
    const q=(sql,replacements={})=>db.query(sql,{replacements,type:/^SELECT/i.test(sql)?QueryTypes.SELECT:QueryTypes.RAW});
    const shared=require('../../src/db/Sequelize.connection');shared.query=(...args)=>db.query(...args);shared.transaction=(...args)=>db.transaction(...args);
    const {AccountLegalService}=require('../../src/services/registration/accountLegal.service');
    const central=new AccountLegalService(db,{legal});
    const dao=require('../../src/Dao/mysql/saasLegal.dao');dao.central=central;
    const actor={id_login:randomUUID(),id_business:randomUUID(),id_session:randomUUID(),rol:'admin'};
    const manifest=await legal.client.getDocumentSet();manifest.revision=randomUUID();
    let now=Date.now(),failDelivery=false,received=[],deliveries=[];
    legal.clock=()=>now;
    legal.client.recordEvidence=async payload=>{
        deliveries.push(JSON.parse(JSON.stringify(payload)));
        if(failDelivery)throw Error('synthetic outage');
        const previous=received.find(item=>item.key===payload.idempotencyKey);if(previous)return previous;
        assert.equal(payload.subjectId,actor.id_login);assert.equal(payload.organizationId,actor.id_business);
        assert.equal(payload.confirmations.length,2);assert.ok(payload.confirmations.every(c=>c.confirmed===true));
        const result={evidenceId:randomUUID(),key:payload.idempotencyKey,recorded:true,occurredAt:payload.occurredAt,
            confirmations:payload.confirmations,documents:manifest.documents.filter(d=>payload.confirmations.some(c=>c.documentVersionId===d.documentVersionId))};
        received.push(result);return result;
    };
    central.read=async(route,owner)=>{
        assert.equal(owner.id_login,actor.id_login);assert.equal(owner.id_business,actor.id_business);
        return route==='evidence/history'?{items:received,nextCursor:null}:{documentSetKey:'registration',revision:manifest.revision,
            pendingDocuments:manifest.documents.filter(d=>!received.some(r=>r.confirmations.some(c=>c.documentVersionId===d.documentVersionId)))};
    };
    let server;
    const checks=[],pass=name=>{checks.push(name);console.log('PASS '+name);};
    try{
        await q("INSERT INTO business(id_business,name,status,subscription_status,active) VALUES(:business,'QA','active','active',1)",{business:actor.id_business});
        await q("INSERT INTO login(id_login,id_business,id_rol,name,email,active) VALUES(:login,:business,'admin','QA','legal-qa@example.test',1)",{login:actor.id_login,business:actor.id_business});
        await q('INSERT INTO `session`(id_session,id_login,active,`last`) VALUES(:session,:login,1,1)',{session:actor.id_session,login:actor.id_login});
        const original=randomUUID();
        await q(`INSERT INTO registration_outbox(event_id,attempt_id,event_type,id_login,id_business,created_at,processed_at,legal_evidence_payload)
            VALUES(:id,:id,'registration.created',:login,:business,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),'{}')`,{id:original,login:actor.id_login,business:actor.id_business});
        const app=express();app.use(cookies());app.use(require('../../src/middleware/requestBody.middleware').defaultBodyParser);
        app.use('/api/saas-legal',require('../../src/routes/mysql/saas-legal'));
        app.use((error,req,res,next)=>res.status(500).json({code:'QA_UNEXPECTED_ERROR'}));
        server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
        const origin='http://127.0.0.1:'+server.address().port;
        process.env.CORS_ALLOWED_ORIGINS=origin;process.env.CSRF_ALLOWED_ORIGINS=origin;
        const token=require('../../src/auth/authenticate').GetAccessToken(actor).token;
        const csrf=require('../../src/services/security/csrfToken.service').issueToken({tokenDecode:actor}).token;
        async function http(method,route,body,options={}){
            const headers={Origin:options.origin||origin,'Content-Type':'application/json'};
            if(!options.anonymous)headers.Cookie='legal_qa_at='+token+'; legal_qa_csrf='+csrf;
            if(!options.noCsrf)headers['X-CSRF-Token']=csrf;
            const res=await fetch(origin+'/api/saas-legal'+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
            return {status:res.status,body:await res.json()};
        }
        const context=async()=>{const res=await http('GET','/central/context');assert.equal(res.status,200,JSON.stringify(res.body));return res.body.data;};
        const input=ctx=>({legalContext:ctx.legalContext,idempotencyKey:randomUUID(),legalAcceptances:ctx.legalDocuments.map(d=>({documentKey:d.documentKey,versionId:d.versionId,acknowledged:true}))});
        assert.equal((await http('GET','/central/context',undefined,{anonymous:true})).status,401);
        const review=await context(),body=input(review);
        assert.equal((await http('POST','/central/accept',body,{noCsrf:true})).status,403);
        assert.equal((await http('POST','/central/accept',body,{origin:'https://evil.invalid'})).status,403);
        assert.equal((await http('POST','/central/accept',{...body,padding:'x'.repeat(9000)})).status,413);
        assert.equal((await http('POST','/central/accept',{...body,subjectId:'foreign'})).status,400);
        assert.equal((await http('POST','/central/accept',{...body,legalAcceptances:body.legalAcceptances.slice(1)})).body.code,'LEGAL_VERSION_STALE');
        assert.equal((await http('POST','/central/accept',{...body,legalAcceptances:body.legalAcceptances.map(d=>({...d,acknowledged:false}))})).status,400);
        const forged={...body,legalContext:body.legalContext+'a'};assert.equal((await http('POST','/central/accept',forged)).body.code,'LEGAL_VERSION_STALE');
        const registration=await legal.context('registration-cookie-not-a-session');
        assert.equal((await http('POST','/central/accept',input(registration))).body.code,'LEGAL_VERSION_STALE');
        const otherSession=await central.review({...actor,id_session:randomUUID()});
        assert.equal((await http('POST','/central/accept',input(otherSession))).body.code,'LEGAL_VERSION_STALE');
        assert.equal((await dao.acceptCentral({...actor,id_business:randomUUID()},body)).status,403);
        assert.equal((await dao.acceptCentral({...actor,id_login:randomUUID()},body)).status,403);
        assert.equal((await q("SELECT COUNT(*) n FROM registration_outbox WHERE event_type='registration.legal_updated'"))[0].n,0);
        pass('real auth/CSRF/origin/8 KiB, exact body, full set, explicit confirmation, HMAC and account/tenant/session binding');
        const replies=await Promise.all([http('POST','/central/accept',body),http('POST','/central/accept',body)]);
        assert.deepEqual(replies.map(r=>r.status),[202,202]);assert.ok(replies.every(r=>r.body.data.eventId===body.idempotencyKey&&r.body.data.queued));
        assert.equal((await q("SELECT COUNT(*) n FROM registration_outbox WHERE event_type='registration.legal_updated'"))[0].n,1);
        const [event]=await q('SELECT * FROM registration_outbox WHERE event_id=:id',{id:body.idempotencyKey});
        const payload=typeof event.legal_evidence_payload==='string'?JSON.parse(event.legal_evidence_payload):event.legal_evidence_payload;
        assert.equal(payload.subjectId,actor.id_login);assert.equal(payload.organizationId,actor.id_business);
        assert.equal(deliveries.length,0,'HTTP commits locally without making a Legal write');
        assert.equal((await http('GET','/central/context')).body.code,'LEGAL_SYNC_PENDING');
        assert.equal((await http('POST','/central/accept',{...body,idempotencyKey:randomUUID()})).body.code,'LEGAL_SYNC_PENDING');
        const pending=await http('GET','/');assert.equal(pending.body.data.central_sync_pending,true);
        assert.equal(pending.body.data.pending_count,0);assert.equal(pending.body.data.documents.filter(d=>d.source==='central').length,2);assert.ok(pending.body.data.documents.filter(d=>d.source==='central').every(d=>d.sync_pending&&!d.accepted));
        pass('concurrent same-key sends commit one event; pending updates suppress reacceptance without inventing a central receipt');
        failDelivery=true;await legal.flush();
        let [waiting]=await q('SELECT * FROM registration_outbox WHERE event_id=:id',{id:body.idempotencyKey});
        assert.equal(waiting.processed_at,null);assert.ok(waiting.legal_retry_at);assert.equal(received.length,0);
        now+=7200000;
        const retry=await http('POST','/central/accept',body);assert.equal(retry.status,202,'Committed retry survives context expiry');
        assert.equal((await http('POST','/central/accept',{...body,idempotencyKey:randomUUID()})).body.code,'LEGAL_VERSION_STALE');
        failDelivery=false;await q('UPDATE registration_outbox SET legal_retry_at=NULL WHERE event_id=:id',{id:body.idempotencyKey});await legal.flush();
        assert.equal(received.length,1);assert.deepEqual(deliveries[0],deliveries[1],'Provider retry preserves occurrence time and idempotency key');
        const replay=await http('POST','/central/accept',body);assert.equal(replay.status,200);assert.equal(replay.body.data.queued,false);assert.equal(replay.body.data.evidenceId,received[0].evidenceId);
        assert.equal((await http('GET','/')).body.data.central_sync_pending,false);
        const history=await http('GET','/history');assert.equal(history.body.data.acceptances.length,2);
        assert.ok(history.body.data.acceptances.every(r=>r.evidence_id===received[0].evidenceId));
        pass('provider outage/retry and expired committed replay preserve payload; confirmed receipt appears in history after delivery');
        manifest.expiresAt=new Date(now+3600000).toISOString();manifest.snapshotToken=randomUUID();manifest.documents[0]={...manifest.documents[0],documentVersionId:randomUUID(),version:'2.0.0'};
        const next=await context(),nextBody=input(next);
        assert.equal((await http('POST','/central/accept',{...nextBody,idempotencyKey:body.idempotencyKey})).body.code,'LEGAL_IDEMPOTENCY_CONFLICT');
        const transaction=db.transaction.bind(db);db.transaction=async(...args)=>{const tx=await transaction(...args);const commit=tx.commit.bind(tx);tx.commit=async()=>{await tx.rollback();throw Error('synthetic commit failure');};return tx;};
        assert.equal((await http('POST','/central/accept',nextBody)).status,500);db.transaction=transaction;
        assert.equal((await q('SELECT COUNT(*) n FROM registration_outbox WHERE event_id=:id',{id:nextBody.idempotencyKey}))[0].n,0);
        const displayedVersion=manifest.documents[0].documentVersionId;
        manifest.documents[0]={...manifest.documents[0],documentVersionId:randomUUID(),version:'3.0.0'};
        assert.equal((await http('POST','/central/accept',nextBody)).status,202);
        const [saved]=await q('SELECT legal_evidence_payload FROM registration_outbox WHERE event_id=:id',{id:nextBody.idempotencyKey});
        const sent=typeof saved.legal_evidence_payload==='string'?JSON.parse(saved.legal_evidence_payload):saved.legal_evidence_payload;
        assert.ok(sent.confirmations.some(c=>c.documentVersionId===displayedVersion));assert.ok(!sent.confirmations.some(c=>c.documentVersionId===manifest.documents[0].documentVersionId));
        assert.equal(received.length,1,'A failed commit or a later publication never records an undisplayed version');
        await q('UPDATE login SET active=0 WHERE id_login=:id',{id:actor.id_login});assert.equal((await http('POST','/central/accept',nextBody)).status,401);
        pass('immutable displayed versions, conflicting key, SQL rollback/retry and revoked account; no configured DB or live Legal writes');
        console.log('PASS account legal confirmation: '+checks.length+' integration groups');
    }finally{if(server)await new Promise(resolve=>server.close(resolve));await fixture.close();}
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

'use strict';
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const databasePath=require.resolve('../../src/db/Sequelize.connection');
require.cache[databasePath]={id:databasePath,filename:databasePath,loaded:true,exports:{}};
const {SaasLegalDao}=require('../../src/Dao/mysql/saasLegal.dao');
const {AccountLegalService}=require('../../src/services/registration/accountLegal.service');
const {LegalRegistrationService}=require('../../src/services/registration/legalRegistration.service');
async function run({useInstalledSdk=true}={}){
    const actor={id_login:'owner',id_business:'clinic',id_session:'session',name:'Synthetic user',role:'admin'};
    const doc={documentId:randomUUID(),documentVersionId:randomUUID(),documentKey:'terminos_y_condiciones',title:'Terms',version:'1.0.0',
        contentHash:createHash('sha256').update('<p>Original terms</p>').digest('hex'),requiredAction:'accept',blocking:true,requireReacceptance:true,deadline:null};
    const receipt={evidenceId:randomUUID(),snapshotToken:randomUUID(),recorded:true,occurredAt:'2026-11-01T10:00:00Z',receivedAt:'2026-11-01T10:00:01Z',
        documents:[doc],confirmations:[{documentVersionId:doc.documentVersionId,contentHash:doc.contentHash,action:'accept',confirmed:true}]};
    const manifest={applicationId:randomUUID(),documentSetKey:'registration',revision:randomUUID(),snapshotToken:randomUUID(),expiresAt:new Date(Date.now()+600000).toISOString(),
        documents:[{...doc,artifacts:{html:{url:'https://files.example/terms',expiresAt:new Date(Date.now()+600000).toISOString(),contentType:'text/html',size:21,sha256:doc.contentHash}}}]};
    let synced=true,outage=false,denied=false,pending=false,reviewDocs=null,html='<p>Original terms</p>',historyItems=[receipt],nextCursor=null;
    const events=new Map();
    const db={async query(sql,options){
        const params=options.replacements;
        if(sql.startsWith('SELECT id_session FROM'))return params.session===actor.id_session?[{id_session:actor.id_session}]:[];
        if(sql.startsWith('SELECT id_login,name FROM login'))return [{id_login:'another-signer',name:'Previous administrator'}];
        if(sql.includes('FROM registration_outbox WHERE event_id='))return events.has(params.id)?[events.get(params.id)]:[];
        if(sql.includes('FROM registration_outbox')){
            assert.doesNotMatch(sql,/registration\.created/);
            assert.equal(params.login,actor.id_login);assert.equal(params.business,actor.id_business);
            return synced?[]:[{event_id:'pending-event'}];
        }
        if(sql.includes('INSERT INTO registration_outbox')){
            assert.ok(options.transaction);
            events.set(params.id,{event_id:params.id,id_login:params.login,id_business:params.business,
                event_type:'registration.legal_updated',legal_evidence_payload:params.payload,processed_at:null});
            synced=false;
            return [];
        }
        if(sql.startsWith('SELECT d.document_key,v.required')){
            assert.equal(params.key,'license_agreement');
            assert.doesNotMatch(sql,/content_html/);
            return [{document_key:'license_agreement',required:1}];
        }
        if(sql.startsWith('SELECT * FROM saas_legal_versions WHERE id_version='))return [{id_document:'terms_conditions',id_version:params.version}];
        if(sql.startsWith('SELECT * FROM saas_legal_documents WHERE id_document='))return [{document_key:'terms_conditions',current_version_id:'terms_conditions-v1'}];
        if(sql.startsWith('SELECT * FROM saas_legal_documents WHERE document_key='))return [{id_document:params.key,document_key:params.key,current_version_id:params.key+'-v1'}];
        if(sql.startsWith('SELECT v.*'))return [{id_document:params.document,id_version:params.version,title:params.document,version_number:1,required:1}];
        if(sql.startsWith('SELECT * FROM saas_legal_acceptances'))return [];
        if(sql.startsWith('SELECT a.*'))return [{id_acceptance:'old-receipt',id_version:'local-v1',id_document:'terms_conditions',document_key:'terms_conditions',
            title:'Old terms',version_number:1,acceptance_scope:'user',accepted_at:'2026-10-01T00:00:00Z',content_html:'<p>Old local terms</p>'}];
        throw Error('Unexpected SQL');
    },async transaction(){return {async commit(){},async rollback(){}};}};
    const oldFetch=global.fetch,oldEnv=process.env.NODE_ENV,oldKey=process.env.REGISTRATION_HMAC_KEY;
    process.env.NODE_ENV='test';process.env.REGISTRATION_HMAC_KEY='73'.repeat(32);
    let tokenCalls=0,readCalls=0,historyCalls=0,snapshotCalls=0,artifactCalls=0;
    let sets=[],organizationHistory=[],organizationPending=[],machineClaims;
    global.fetch=async(url,options={})=>{
        url=String(url);
        if(url.endsWith('/oauth/introspect'))return Response.json(machineClaims);
        if(url.endsWith('/oauth/token')){
            tokenCalls++;assert.equal(options.body.get('scope'),'legal.integration.acceptances.prepare');
            assert.equal(options.body.get('resource'),'http://localhost:3017');assert.equal(options.body.get('audience'),'legal-api');
            return Response.json({access_token:'synthetic-read-token',token_type:'Bearer',expires_in:300,scope:'legal.integration.acceptances.prepare'});
        }
        if(url.includes('/document-sets/registration')){snapshotCalls++;return Response.json(manifest);}
        if(url.includes('/integrations/')){
            readCalls++;assert.equal(new Headers(options.headers).get('authorization'),'Bearer synthetic-read-token');
            const input=JSON.parse(options.body);
            assert.equal(input.subjectId,actor.id_login);assert.equal(input.organizationId,actor.id_business);
            assert.equal(input.applicationId,manifest.applicationId);
            assert.equal(options.redirect,'error');
            if(outage)return Response.json({private:'not forwarded'},{status:503});
            if(denied)return Response.json({},{status:403});
            if(url.endsWith('/account-catalog')){assert.equal(input.documentSetKey,undefined);return Response.json({sets});}
            if(input.documentSetKey==='account_contracts'){
                if(url.endsWith('/account-document')){
                    const item=sets[0].documents.find(doc=>doc.documentVersionId===input.documentVersionId);
                    assert.ok(item);
                    return Response.json({document:{id:item.documentId},version:{id:item.documentVersionId},contentHash:item.contentHash,
                        artifacts:{html:{url:'https://files.example/terms'}}});
                }
                if(url.endsWith('/pending/prepare')){assert.equal(input.sessionId,actor.id_session);return Response.json({...manifest,documentSetKey:input.documentSetKey,documents:organizationPending});}
                if(url.endsWith('/evidence/history'))return Response.json({items:organizationHistory,nextCursor:null});
                return Response.json({documentSetKey:input.documentSetKey,revision:manifest.revision,pendingDocuments:organizationPending});
            }
            assert.equal(input.documentSetKey,'registration');
            if(url.endsWith('/evidence/history')){historyCalls++;return Response.json({items:historyItems,nextCursor});}
            if(url.endsWith('/pending/prepare'))return Response.json({...manifest,documents:reviewDocs??(pending?manifest.documents:[])});
            assert.ok(url.endsWith('/pending/evaluate'),'Only read-only Legal operations are called');
            return Response.json({documentSetKey:'registration',revision:manifest.revision,pendingDocuments:pending?[doc]:[],allowed:!pending});
        }
        if(url.includes('/documents/')){
            const item=manifest.documents.find(d=>url.includes('/documents/'+d.documentKey+'/versions/'+d.version+'?locale=es-MX'));
            assert.ok(item,'The request addresses the exact version from the current set or receipt');
            return Response.json({document:{id:item.documentId},version:{id:item.documentVersionId,publishedAt:'2026-11-01T00:00:00Z'},
                contentHash:item.contentHash,artifacts:item.artifacts});
        }
        assert.equal(url,'https://files.example/terms');assert.equal(options.redirect,'error');artifactCalls++;return new Response(html);
    };
    const legal=new LegalRegistrationService(db,{env:{LEGAL_API_URL:'http://localhost:3017',HEMIA_ID_URL:'http://localhost:4000',
        HEMIA_CLIENT_ID:'synthetic-client',HEMIA_CLIENT_SECRET:'synthetic-secret',LEGAL_APPLICATION_ID:manifest.applicationId,LEGAL_DOCUMENT_ORIGINS:'https://files.example'}});
    const machine=useInstalledSdk?null:{async request(_destination,route,options){
        return global.fetch('http://localhost:3017/'+route,{...options,redirect:'error',
            headers:{...options.headers,authorization:'Bearer synthetic-read-token'}});
    }};
    if(!useInstalledSdk)legal.client={async getDocumentSet(){
        return (await global.fetch('http://localhost:3017/document-sets/registration')).json();
    }};
    const central=new AccountLegalService(db,{legal,machine});
    const dao=new SaasLegalDao(db,central);
    dao.actor=async context=>context.id_login===actor.id_login&&context.id_business===actor.id_business?actor:null;
    try{
        pending=true;
        assert.deepEqual((await dao.notice(actor)).data,{pending_count:2,business_pending:true,central_sync_pending:false,pending_unknown:false});
        assert.equal(snapshotCalls,0);assert.equal(historyCalls,0);assert.equal(artifactCalls,0);
        synced=false;assert.equal((await dao.notice(actor)).data.pending_count,1);
        assert.equal((await dao.notice(actor)).data.central_sync_pending,true);synced=true;pending=false;
        outage=true;assert.equal((await dao.notice(actor)).data.pending_unknown,true);outage=false;
        const publicReads=readCalls;
        const terms=await dao.publicDocument('terms_conditions');
        assert.equal(terms.data.document.current_version.content_html,html);
        assert.equal(terms.data.document.current_version.version_number,'1.0.0');
        assert.equal(terms.data.document.current_version.published_at,'2026-11-01T00:00:00Z');
        const privacy={...manifest.documents[0],documentKey:'aviso_de_privacidad',requiredAction:'acknowledge',documentId:randomUUID(),documentVersionId:randomUUID()};
        manifest.documents.push(privacy);
        assert.equal((await dao.publicDocument('privacy_notice')).data.document.current_version.id_version,privacy.documentVersionId);
        assert.equal((await dao.publicDocument('license_agreement')).status,404);
        assert.equal(readCalls,publicReads,'Public pages make no authenticated evidence requests');
        manifest.documents.pop();
        assert.equal((await dao.publicDocument('privacy_notice')).status,404);
        html='<p>tampered public copy</p>';assert.equal((await dao.publicDocument('terms_conditions')).status,503);html='<p>Original terms</p>';
        const result=await dao.current(actor);assert.equal(result.status,200);assert.equal(result.data.central_available,true);
        assert.deepEqual(result.data.documents.map(d=>d.document_key),['license_agreement','terminos_y_condiciones']);
        const current=result.data.documents.find(d=>d.source==='central');
        assert.equal(current.pending,false);assert.equal(current.can_accept,false);assert.equal(current.accepted.evidence_id,receipt.evidenceId);
        assert.equal(result.data.pending_count,1,'The unrelated local licence remains pending');
        const history=await dao.history(actor);assert.equal(history.data.acceptances.length,2);
        assert.equal(history.data.acceptances[0].source,'central');assert.equal(history.data.acceptances[1].id_acceptance,'old-receipt');
        assert.equal((await dao.centralDocument(actor,doc.documentVersionId)).data.version.content_html,html);
        html='<p>tampered</p>';assert.equal((await dao.centralDocument(actor,doc.documentVersionId)).status,503);html='<p>Original terms</p>';
        const before=readCalls;
        assert.equal((await dao.history({...actor,id_business:'other'})).status,403);assert.equal(readCalls,before);
        assert.equal((await dao.centralDocument({...actor,id_login:'other'},doc.documentVersionId)).status,403);assert.equal(readCalls,before);
        assert.equal((await dao.centralContext({...actor,id_business:'other'})).status,403);assert.equal(readCalls,before);
        denied=true;const beforeDenied=snapshotCalls;
        assert.equal((await dao.centralContext(actor)).status,503);
        assert.equal(snapshotCalls,beforeDenied,'Denied organizations cannot obtain an account review context');
        denied=false;
        outage=true;const failed=await dao.current(actor);assert.equal(failed.data.pending_unknown,true);assert.equal(failed.data.central_available,false);
        assert.deepEqual(failed.data.documents.map(d=>d.document_key),['license_agreement']);
        assert.equal((await dao.history(actor)).data.acceptances[0].id_acceptance,'old-receipt');outage=false;
        pending=true;const update=await dao.current(actor);assert.equal(update.data.pending_count,2);
        assert.equal(update.data.documents.find(d=>d.source==='central').accepted,null);
        synced=false;const waiting=await dao.current(actor);assert.equal(waiting.data.central_sync_pending,true);
        assert.equal(waiting.data.documents.find(d=>d.source==='central').pending,false);synced=true;pending=false;
        nextCursor=randomUUID();assert.equal((await dao.history(actor)).data.central_next_cursor,nextCursor);
        assert.equal((await dao.history(actor,nextCursor)).data.acceptances.length,1,'Pagination does not duplicate local history');nextCursor=null;
        historyItems=[{...receipt,confirmations:[{...receipt.confirmations[0],contentHash:'0'.repeat(64)}]}];
        assert.equal((await dao.history(actor)).data.central_available,false,'Mismatched evidence must not be presented as accepted');historyItems=[receipt];
        historyItems=[];pending=true;
        const first=await dao.current(actor);
        assert.equal(first.data.pending_count,2,'Account without any outbox events sees its first central pending document');
        assert.equal((await dao.history(actor)).data.acceptances[0].id_acceptance,'old-receipt');
        assert.equal((await dao.centralDocument(actor,doc.documentVersionId)).status,200);
        assert.equal((await dao.accept(actor,{id_version:'terms_conditions-v1',acknowledged:true})).code,'LEGAL_CENTRAL_REQUIRED');
        assert.equal((await dao.centralContext(actor)).data.legalDocuments.length,1);
        historyItems=[receipt];pending=false;
        assert.equal((await dao.centralContext(actor)).code,'LEGAL_VERSION_STALE');
        manifest.documents.push(privacy);reviewDocs=[privacy];
        const publicSnapshotsBeforeReview=snapshotCalls;
        const review=await dao.centralContext(actor);assert.equal(review.status,200);
        assert.deepEqual(review.data.legalDocuments.map(d=>d.documentKey),['aviso_de_privacidad']);
        assert.equal(snapshotCalls,publicSnapshotsBeforeReview,'Account review never uses the full registration snapshot');
        const input={legalContext:review.data.legalContext,idempotencyKey:randomUUID(),
            legalAcceptances:review.data.legalDocuments.map(d=>({documentKey:d.documentKey,versionId:d.versionId,acknowledged:true}))};
        assert.equal((await dao.acceptCentral({...actor,id_business:'other'},input)).status,403);
        assert.equal((await dao.acceptCentral(actor,input)).status,202);
        assert.equal((await dao.acceptCentral(actor,input)).status,202);assert.equal(events.size,1);
        const evidence=JSON.parse(events.get(input.idempotencyKey).legal_evidence_payload);
        assert.equal(evidence.subjectId,actor.id_login);assert.equal(evidence.organizationId,actor.id_business);
        assert.deepEqual(evidence.confirmations.map(c=>[c.documentVersionId,c.action]),[[privacy.documentVersionId,'acknowledge']]);
        assert.equal((await dao.centralContext(actor)).code,'LEGAL_SYNC_PENDING');
        assert.equal((await dao.history(actor)).data.central_sync_pending,true);
        assert.equal((await dao.current(actor)).data.pending_count,1,'The local licence remains pending while personal evidence is queued');
        historyItems=[receipt];pending=false;synced=true;
        assert.equal((await dao.history(actor)).data.acceptances[0].evidence_id,receipt.evidenceId);
        Object.assign(legal.env,{LEGAL_ACCOUNT_CATALOG_ENABLED:'true',LEGAL_CONTEXT_CALLER_ID:'legal-service',LEGAL_CONTEXT_AUDIENCE:'medsync-api',
            LEGAL_CONTEXT_INTROSPECTION_URL:'http://localhost:4000/oauth/introspect'});
        const contract={...privacy,documentKey:'agreement_qa',title:'Agreement',requiredAction:'accept'};
        const info={...privacy,documentId:randomUUID(),documentVersionId:randomUUID(),documentKey:'read_only_qa',requiredAction:'informational'};
        sets=[{documentSetKey:'account_contracts',name:'Contracts',revision:manifest.revision,evidenceScope:'organization',verification:'verified_session',documents:[contract,info]}];
        const contractVersion=await central.document(actor,contract.documentVersionId,undefined,'account_contracts');
        assert.equal(contractVersion.content_html,html);
        assert.equal(contractVersion.acceptance_scope,'business');
        organizationPending=[contract];
        const account=await dao.current(actor);
        assert.equal(account.data.documents.find(d=>d.document_key===contract.documentKey).central_can_review,true);
        assert.equal(account.data.documents.find(d=>d.document_key===info.documentKey).informational,true);
        assert.equal((await dao.notice(actor)).data.pending_count,2);
        const organizationReview=await dao.centralContext(actor,'account_contracts');
        assert.equal(organizationReview.data.acceptanceScope,'business');
        const submission={...input,documentSetKey:'account_contracts',idempotencyKey:randomUUID(),legalContext:organizationReview.data.legalContext,
            legalAcceptances:[{documentKey:contract.documentKey,versionId:contract.documentVersionId,acknowledged:true}]};
        actor.role='assistant';
        assert.equal((await dao.centralContext(actor,'account_contracts')).status,403);
        assert.equal((await dao.acceptCentral(actor,submission)).status,403);
        actor.role='admin';
        assert.equal((await dao.acceptCentral(actor,{...submission,documentSetKey:'registration'})).code,'LEGAL_VERSION_STALE');
        assert.equal((await dao.acceptCentral(actor,submission)).status,202);
        const organizationEvidence=JSON.parse(events.get(submission.idempotencyKey).legal_evidence_payload);
        assert.equal(organizationEvidence.sessionId,actor.id_session);
        assert.equal(organizationEvidence.organizationId,actor.id_business);
        machineClaims={active:true,exp:Date.now()/1000+60,aud:'medsync-api',client_id:'legal-service',scope:'legal.consumer_context.read'};
        const context={subjectId:actor.id_login,organizationId:actor.id_business,sessionId:actor.id_session,documentSetKey:'account_contracts',
            purpose:'document_acceptance',operation:'record'};
        assert.equal((await dao.representativeContext('Bearer qa-token',context)).data.canAcceptDocuments,true);
        assert.equal((await dao.representativeContext('Bearer qa-token',{...context,sessionId:'revoked'})).status,403);
        machineClaims={...machineClaims,aud:'other-api'};
        assert.equal((await dao.representativeContext('Bearer qa-token',context)).status,403);
        organizationHistory=[{...receipt,evidenceId:randomUUID(),signerSubjectId:'another-signer',documents:[contract],
            confirmations:[{documentVersionId:contract.documentVersionId,contentHash:contract.contentHash,action:'accept',confirmed:true}]}];
        organizationPending=[];synced=true;
        const shared=(await dao.history(actor)).data.acceptances.find(item=>item.document_set_key==='account_contracts');
        assert.equal(shared.accepted_by_id,'another-signer');assert.equal(shared.accepted_by_name,'Previous administrator');
        assert.equal(shared.acceptance_scope,'business');
        events.get(submission.idempotencyKey).legal_error_code='LEGAL_REPRESENTATIVE_REJECTED';
        assert.equal((await dao.acceptCentral(actor,submission)).code,'LEGAL_REPRESENTATIVE_REJECTED');
        delete legal.env.LEGAL_ACCOUNT_CATALOG_ENABLED;
        delete legal.env.LEGAL_APPLICATION_ID;
        assert.deepEqual((await dao.current(actor)).data.documents.map(d=>d.document_key),['license_agreement'],
            'A service URL without an assigned application exposes only the local licence');
        assert.equal((await dao.history(actor)).data.acceptances.length,1);
        if(useInstalledSdk)assert.equal(tokenCalls,1,'Read tokens are reused, scoped and independent of recording tokens');
        console.log('PASS account legal: personal and organization review, representative verification, preserved history/licence, scoped reads, queue states and exact versions.');
    }finally{
        global.fetch=oldFetch;
        if(oldEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldEnv;
        if(oldKey===undefined)delete process.env.REGISTRATION_HMAC_KEY;else process.env.REGISTRATION_HMAC_KEY=oldKey;
    }
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

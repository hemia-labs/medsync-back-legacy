'use strict';
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const databasePath=require.resolve('../../src/db/Sequelize.connection');
require.cache[databasePath]={id:databasePath,filename:databasePath,loaded:true,exports:{}};
const {SaasLegalDao}=require('../../src/Dao/mysql/saasLegal.dao');
const {AccountLegalService}=require('../../src/services/registration/accountLegal.service');
const {LegalRegistrationService}=require('../../src/services/registration/legalRegistration.service');
async function run(){
    const actor={id_login:'owner',id_business:'clinic',name:'Synthetic user',role:'admin'};
    const doc={documentId:randomUUID(),documentVersionId:randomUUID(),documentKey:'terminos_y_condiciones',title:'Terms',version:'1.0.0',
        contentHash:createHash('sha256').update('<p>Original terms</p>').digest('hex'),requiredAction:'accept',blocking:true,requireReacceptance:true,deadline:null};
    const receipt={evidenceId:randomUUID(),snapshotToken:randomUUID(),recorded:true,occurredAt:'2026-11-01T10:00:00Z',receivedAt:'2026-11-01T10:00:01Z',
        documents:[doc],confirmations:[{documentVersionId:doc.documentVersionId,contentHash:doc.contentHash,action:'accept',confirmed:true}]};
    const manifest={applicationId:randomUUID(),documentSetKey:'registration',revision:randomUUID(),snapshotToken:randomUUID(),expiresAt:new Date(Date.now()+600000).toISOString(),
        documents:[{...doc,artifacts:{html:{url:'https://files.example/terms',expiresAt:new Date(Date.now()+600000).toISOString(),contentType:'text/html',size:21,sha256:doc.contentHash}}}]};
    let origin=true,synced=true,outage=false,pending=false,html='<p>Original terms</p>',historyItems=[receipt],nextCursor=null;
    const db={async query(sql,options){
        if(sql.includes('FROM registration_outbox'))return origin&&options.replacements.login===actor.id_login&&options.replacements.business===actor.id_business
            ?[{event_id:randomUUID(),processed_at:synced?new Date():null,sync_pending:synced?0:1,legal_evidence_id:synced?receipt.evidenceId:null}]:[];
        if(sql.startsWith('SELECT * FROM saas_legal_documents'))return ['terms_conditions','privacy_notice','license_agreement'].map(key=>({id_document:key,document_key:key,current_version_id:key+'-v1'}));
        if(sql.startsWith('SELECT v.*'))return ['terms_conditions','privacy_notice','license_agreement'].map(key=>({id_document:key,id_version:key+'-v1',title:key,version_number:1,required:1}));
        if(sql.startsWith('SELECT * FROM saas_legal_acceptances'))return [];
        if(sql.startsWith('SELECT a.*'))return [{id_acceptance:'old-receipt',id_version:'local-v1',id_document:'terms_conditions',document_key:'terms_conditions',
            title:'Old terms',version_number:1,acceptance_scope:'user',accepted_at:'2026-10-01T00:00:00Z',content_html:'<p>Old local terms</p>'}];
        throw Error('Unexpected SQL');
    }};
    const oldFetch=global.fetch,oldEnv=process.env.NODE_ENV;process.env.NODE_ENV='test';
    let tokenCalls=0,readCalls=0;
    global.fetch=async(url,options={})=>{
        url=String(url);
        if(url.endsWith('/oauth/token')){
            tokenCalls++;assert.equal(options.body.get('scope'),'legal.integration.acceptances.prepare');
            assert.equal(options.body.get('resource'),'http://localhost:3017');assert.equal(options.body.get('audience'),'legal-api');
            return Response.json({access_token:'synthetic-read-token',token_type:'Bearer',expires_in:300,scope:'legal.integration.acceptances.prepare'});
        }
        if(url.includes('/document-sets/registration'))return Response.json(manifest);
        if(url.includes('/integrations/')){
            readCalls++;assert.equal(new Headers(options.headers).get('authorization'),'Bearer synthetic-read-token');
            const input=JSON.parse(options.body);
            assert.equal(input.subjectId,actor.id_login);assert.equal(input.organizationId,actor.id_business);
            assert.equal(input.documentSetKey,'registration');assert.equal(input.applicationId,manifest.applicationId);
            assert.equal(options.redirect,'error');
            if(outage)return Response.json({private:'not forwarded'},{status:503});
            if(url.endsWith('/evidence/history'))return Response.json({items:historyItems,nextCursor});
            assert.ok(url.endsWith('/pending/evaluate'),'Only read-only Legal operations are called');
            return Response.json({documentSetKey:'registration',revision:manifest.revision,pendingDocuments:pending?[doc]:[],allowed:!pending});
        }
        if(url.includes('/documents/'))return Response.json({document:{id:doc.documentId},version:{id:doc.documentVersionId},contentHash:doc.contentHash,artifacts:manifest.documents[0].artifacts});
        assert.equal(url,'https://files.example/terms');assert.equal(options.redirect,'error');return new Response(html);
    };
    const legal=new LegalRegistrationService(db,{env:{LEGAL_API_URL:'http://localhost:3017',HEMIA_ID_URL:'http://localhost:4000',
        HEMIA_CLIENT_ID:'synthetic-client',HEMIA_CLIENT_SECRET:'synthetic-secret',LEGAL_APPLICATION_ID:manifest.applicationId,LEGAL_DOCUMENT_ORIGINS:'https://files.example'}});
    const central=new AccountLegalService(db,{legal});
    const dao=new SaasLegalDao(db,central);
    dao.actor=async context=>context.id_login===actor.id_login&&context.id_business===actor.id_business?actor:null;
    try{
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
        origin=false;const legacy=await dao.current(actor);assert.equal(legacy.data.documents.length,3);
        assert.equal(legacy.data.documents.some(d=>d.accepted),false,'Central receipts never mark local documents as accepted');
        assert.equal((await dao.history(actor)).data.acceptances.length,1);
        assert.equal(tokenCalls,1,'Read tokens are reused, scoped and independent of recording tokens');
        console.log('PASS account legal: central authority, preserved local history/licence, confirmed receipts, source isolation, outage/queue states, paging, version/hash validation and scoped OAuth reads.');
    }finally{global.fetch=oldFetch;if(oldEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldEnv;}
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

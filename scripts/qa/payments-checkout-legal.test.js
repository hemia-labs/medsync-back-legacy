'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {CheckoutLegalService}=require('../../src/services/payments/checkoutLegal.service');
const {PaymentsService}=require('../../src/services/payments/payments.service');
const actor={id_login:randomUUID(),id_business:randomUUID(),id_session:randomUUID()};
function fixture() {
    const html='<h1>Condiciones publicadas</h1><p>Contenido legal de prueba.</p>';
    const doc={documentId:randomUUID(),documentVersionId:randomUUID(),contentHash:createHash('sha256').update(html).digest('hex'),
        title:'Aviso de privacidad',version:'1.0.0',kind:'privacy_notice',artifacts:{html:{url:'https://documents.example.test/legal.html?signature=synthetic'}}};
    const prepared={requestId:randomUUID(),identitySourceId:randomUUID(),productCode:'medsync',expiresAt:new Date(Date.now()+600000).toISOString(),documents:[doc]};
    const receipt={source:'central',id_version:doc.documentVersionId,content_hash:doc.contentHash,id_business:actor.id_business,
        accepted_by_id:actor.id_login,evidence_id:randomUUID(),accepted_at:new Date(Date.now()-60000).toISOString()};
    const accepted={id_document:'central:'+doc.documentId,required_action:'acknowledge',pending:false,
        current_version:{id_version:doc.documentVersionId,content_hash:doc.contentHash},accepted:receipt};
    const calls=[];let registered=[accepted],response=html,historyFail=false;
    const service=new CheckoutLegalService({}, {env:{LEGAL_DOCUMENT_ORIGINS:'https://documents.example.test'},
        registration:{current:async actual=>{assert.deepEqual(actual,actor);if(historyFail)throw Error('offline');return registered;}},
        fetch:async(url,options)=>{calls.push({url,options});return new Response(response);}});
    return {service,prepared,doc,receipt,accepted,calls,html,setRegistered:value=>{registered=value;},setResponse:value=>{response=value;},historyFail:()=>{historyFail=true;}};
}
test('preparation returns complete hash-verified documents and exact registration evidence without accepting a checkout',async()=>{
    const f=fixture(),result=await f.service.documents(actor,f.prepared);
    assert.equal(result.requestId,f.prepared.requestId);assert.equal(result.documents[0].contentHtml,f.html);
    assert.equal(result.documents[0].acceptedInRegistration,true);assert.equal(result.documents[0].acceptedAt,f.receipt.accepted_at);
    assert.equal(result.documents[0].requiredAction,'acknowledge');assert.equal(result.legalAcceptanceId,undefined);
    assert.equal(f.calls[0].options.redirect,'error');assert(f.calls[0].options.signal instanceof AbortSignal);
    assert.equal(f.calls[0].options.headers,undefined,'Artifact fetch never forwards service credentials');
});
test('different versions, hashes, subjects, organizations, pending or unavailable evidence never preaccept documents',async()=>{
    for(const alter of [f=>{f.accepted.pending=true;},f=>{f.receipt.id_version=randomUUID();},f=>{f.receipt.content_hash='0'.repeat(64);},
        f=>{f.receipt.accepted_by_id=randomUUID();},f=>{f.receipt.id_business=randomUUID();},f=>{f.accepted.id_document='central:'+randomUUID();},
        f=>{f.receipt.source='local';},f=>{f.receipt.accepted_at='invalid';},f=>f.setRegistered([]),f=>f.historyFail()]) {
        const f=fixture();alter(f);const result=await f.service.documents(actor,f.prepared);
        assert.equal(result.documents[0].acceptedInRegistration,false);assert.equal(result.documents[0].acceptedAt,null);
    }
});
test('committed registration avoids duplicate review while the central receipt is still being delivered',async()=>{
    const f=fixture(),eventId=randomUUID();f.accepted.pending=true;f.accepted.accepted=null;
    const payload={idempotencyKey:eventId,snapshotToken:randomUUID(),subjectId:actor.id_login,organizationId:actor.id_business,
        occurredAt:new Date(Date.now()-10000).toISOString(),confirmations:[{documentVersionId:f.doc.documentVersionId,contentHash:f.doc.contentHash,action:'acknowledge',confirmed:true}]};
    const row={event_id:eventId,event_type:'registration.created',id_login:actor.id_login,id_business:actor.id_business,
        legal_error_code:null,legal_evidence_payload:JSON.stringify(payload)};
    f.service.db={query:async(sql,options)=>{assert.match(sql,/WHERE id_login=:login AND id_business=:business/);assert.deepEqual(options.replacements,{login:actor.id_login,business:actor.id_business});return [row];}};
    let result=await f.service.documents(actor,f.prepared);
    assert.equal(result.documents[0].acceptedInRegistration,true);assert.equal(result.documents[0].acceptanceSource,'registration_committed');assert.equal(result.legalAcceptanceId,undefined);
    for(const change of [v=>{v.subjectId=randomUUID();},v=>{v.organizationId=randomUUID();},v=>{v.idempotencyKey=randomUUID();},
        v=>{v.occurredAt=new Date(Date.now()+60000).toISOString();},v=>{v.snapshotToken='invalid';},
        v=>{v.confirmations[0].action='accept';},v=>{v.confirmations[0].confirmed=false;},v=>{v.confirmations[0].contentHash='0'.repeat(64);},
        v=>{v.confirmations[0].documentVersionId=randomUUID();},v=>{v.confirmations.push(v.confirmations[0]);}]) {
        const bad=structuredClone(payload);change(bad);row.legal_evidence_payload=JSON.stringify(bad);
        result=await f.service.documents(actor,f.prepared);assert.equal(result.documents[0].acceptedInRegistration,false);
    }
    row.legal_evidence_payload=JSON.stringify(payload);row.legal_error_code='LEGAL_HTTP_403';assert.equal((await f.service.documents(actor,f.prepared)).documents[0].acceptedInRegistration,false);
    row.legal_error_code=null;f.setRegistered([]);assert.equal((await f.service.documents(actor,f.prepared)).documents[0].acceptedInRegistration,false,'A current trusted descriptor is still required');
});
test('untrusted, credentialed, HTTP, redirected, missing HTML or mismatched publications fail closed',async()=>{
    for(const url of ['https://untrusted.example.test/legal','http://127.0.0.1:3009/private','https://user:secret@documents.example.test/legal',
        'https://documents.example.test/legal#fragment','javascript:alert(1)']) {
        const f=fixture();f.doc.artifacts.html.url=url;await assert.rejects(f.service.documents(actor,f.prepared),e=>e.code==='LEGAL_UNAVAILABLE');assert.equal(f.calls.length,0);
    }
    const altered=fixture();altered.setResponse('<p>Changed content</p>');await assert.rejects(altered.service.documents(actor,altered.prepared),e=>e.code==='LEGAL_UNAVAILABLE');
    const missing=fixture();delete missing.doc.artifacts.html;await assert.rejects(missing.service.documents(actor,missing.prepared));
    const oversized=fixture();oversized.setResponse('x'.repeat(512*1024+1));await assert.rejects(oversized.service.documents(actor,oversized.prepared),e=>e.code==='LEGAL_UNAVAILABLE');
    const redirect=fixture();redirect.service.fetch=async()=>new Response(null,{status:302,headers:{location:'https://untrusted.example.test'}});
    await assert.rejects(redirect.service.documents(actor,redirect.prepared),e=>e.code==='LEGAL_UNAVAILABLE');
});
test('expired, duplicate or oversized document sets cannot be presented or confirmed',async()=>{
    for(const change of [f=>{f.prepared.expiresAt='2000-01-01';},f=>{f.prepared.documents.push(f.doc);},f=>{f.prepared.documents=[];},
        f=>{f.prepared.documents=Array(21).fill(f.doc);},f=>{f.doc.documentVersionId='invalid';}]) {
        const f=fixture();change(f);await assert.rejects(f.service.documents(actor,f.prepared),e=>e.code==='LEGAL_UNAVAILABLE');assert.equal(f.calls.length,0);
    }
});
test('payments orchestration binds the documents to the verified native buyer and never accepts on preload',async()=>{
    const f=fixture(),calls=[];
    const service=new PaymentsService({query:async()=>[{...actor,rol:'admin',email_verified:1,subscription_status:'trial'}]},
        {runtime:{config:{successUrl:'https://example.test/return',cancelUrl:'https://example.test/cancel',receiver:{audience:'medsync'},legal:{verificationClientId:'legal'}},
            legal:{prepare:async(context,key)=>{calls.push({context,key});return f.prepared;},accept:async()=>{throw Error('Preload must never accept');}}},
        checkoutLegal:f.service});
    const key=randomUUID(),result=await service.prepareLegal(actor,{idempotencyKey:key});
    assert.equal(result.documents[0].acceptedInRegistration,true);assert.equal(calls.length,1);assert.equal(calls[0].context.subjectId,actor.id_login);
    assert.equal(calls[0].context.organizationId,actor.id_business);assert.equal(calls[0].key,key);
    await assert.rejects(service.prepareLegal(actor,{idempotencyKey:key,acceptedInRegistration:true}),e=>e.status===400);
});

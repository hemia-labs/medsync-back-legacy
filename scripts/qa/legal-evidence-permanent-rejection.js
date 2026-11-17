'use strict';
const assert=require('node:assert/strict');
const {LegalRegistrationService}=require('../../src/services/registration/legalRegistration.service');
const {RegistrationError}=require('../../src/services/registration/errors');
async function flushWith(attempts,code,type='registration.legal_updated'){
    const updates=[];
    const db={async query(sql,options={}){
        if(sql.includes('SELECT * FROM registration_outbox'))return [{event_id:'e1',event_type:type,legal_attempts:attempts,legal_evidence_payload:'{}'}];
        if(sql.includes('legal_error_code=:code'))updates.push(options.replacements);
        return [];
    },async transaction(callback){return callback({});}};
    const service=new LegalRegistrationService(db,{env:{}});
    service.deliver=async()=>{throw new RegistrationError(code,404);};
    await service.flush(1);
    return updates[0];
}
(async()=>{
    assert.equal((await flushWith(3,'LEGAL_HTTP_404')).code,'LEGAL_HTTP_404','Early failures keep retrying');
    assert.equal((await flushWith(9,'LEGAL_HTTP_404')).code,'LEGAL_EVIDENCE_REJECTED','Persistent 404 stops blocking the account');
    assert.equal((await flushWith(88,'LEGAL_UNAVAILABLE')).code,'LEGAL_UNAVAILABLE','Outages are always retried');
    assert.equal((await flushWith(88,'LEGAL_HTTP_404','registration.created')).code,'LEGAL_HTTP_404','Registration events are never discarded');
    console.log('PASS legal evidence: persistent 404/409 evidence is released, outages and registration events keep retrying.');
})().catch(error=>{console.error(error);process.exitCode=1;});

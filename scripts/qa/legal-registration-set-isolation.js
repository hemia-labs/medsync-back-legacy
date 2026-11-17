'use strict';
const assert=require('node:assert/strict');
const {run}=require('./account-legal-regression');
const {LegalRegistrationService}=require('../../src/services/registration/legalRegistration.service');
const {AccountLegalService}=require('../../src/services/registration/accountLegal.service');

(async()=>{
    // Run the same end-to-end service/DAO suite with an isolated central namespace.
    // The public MedSync API still exposes "registration"; all central requests must use this key.
    await run({registrationSetKey:'registration-prod'});
    const env={LEGAL_API_URL:'https://legal.example',HEMIA_ID_URL:'https://id.example',
        HEMIA_CLIENT_ID:'synthetic-client',HEMIA_CLIENT_SECRET:'synthetic-only',
        LEGAL_APPLICATION_ID:'11111111-1111-4111-8111-111111111111'};
    const legal=new LegalRegistrationService({}, {env});
    assert.equal(legal.configuration().registrationSetKey,'registration');
    for(const key of ['', '../registration','UPPER',' registration','a','x'.repeat(81)]) {
        env.LEGAL_REGISTRATION_SET_KEY=key;
        assert.throws(()=>legal.configuration(),error=>error.code==='LEGAL_UNAVAILABLE');
    }
    env.LEGAL_REGISTRATION_SET_KEY='registration-prod';
    let requested;
    legal.client={async getDocumentSet(input){requested=input;return {marker:'snapshot'};}};
    legal.contextFromSnapshot=async(owner,snapshot)=>({owner,...snapshot});
    assert.deepEqual(await legal.context('synthetic-owner'),{owner:'synthetic-owner',marker:'snapshot'});
    assert.equal(requested.documentSetKey,'registration-prod');
    let responseKey='registration';
    const central=new AccountLegalService({}, {legal,machine:{async request(_destination,_route,options){
        assert.equal(JSON.parse(options.body).documentSetKey,'registration-prod');
        return Response.json({documentSetKey:responseKey,documents:[]});
    }}});
    await assert.rejects(()=>central.read('pending/prepare',{id_login:'qa',id_business:'qa'}),/CENTRAL_LEGAL_UNAVAILABLE/);
    responseKey='registration-prod';
    assert.equal((await central.read('pending/prepare',{id_login:'qa',id_business:'qa'})).documentSetKey,'registration');
    env.LEGAL_ACCOUNT_CATALOG_ENABLED='true';
    central.read=async()=>({sets:[{documentSetKey:'registration-prod',revision:'11111111-1111-4111-8111-111111111111',
        name:'Invalid account alias',evidenceScope:'individual',verification:'collector_attested',documents:[]}]});
    await assert.rejects(()=>central.accountSets({}),/CENTRAL_LEGAL_UNAVAILABLE/);
    console.log('PASS Legal set isolation: registration, account, public versions, history, representative, invalid configuration and cross-set rejection.');
})().catch(error=>{console.error(error);process.exitCode=1;});

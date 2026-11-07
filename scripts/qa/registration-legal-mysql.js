'use strict';
// Disposable MySQL only. Legal/OAuth use synthetic Responses, never shared providers.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {Sequelize,QueryTypes}=require('sequelize');
const mysql=require('mysql2/promise');
async function main(){
    const port=Number(process.env.S26_QA_PORT);
    assert.equal(process.env.S26_QA_ISOLATED,'1');assert.ok(port>1024&&port!==3306);
    Object.assign(process.env,{NODE_ENV:'test',APP_ENV:'test',DB_HOST:'127.0.0.1',DB_PORT:String(port),DB_USER:'root',DB_PASSWORD:'isolated-test-only',DB_NAME:'medsync_legal_test',REGISTRATION_IDENTITY_ENABLED:'true',REGISTRATION_HMAC_KEY:randomBytes(32).toString('hex')});
    const setup=await mysql.createConnection({host:'127.0.0.1',port,user:'root',password:'isolated-test-only',database:'medsync_legal_test'});
    try{
        await setup.query(fs.readFileSync(require('node:path').join(__dirname,'../migrations/s24-registration-provisioning.sql'),'utf8'));
        const migration=require('../migrations/s26-registration-legal-evidence');assert.equal((await migration.apply(setup,true)).applied,true);assert.equal((await migration.apply(setup,true)).alreadyApplied,true);
        for(const sql of [
            'CREATE TABLE registration_attempt(attempt_id CHAR(36) PRIMARY KEY,scope_hash CHAR(64),payload_hash CHAR(64),id_login VARCHAR(50),id_business VARCHAR(50),expires_at DATETIME(3)) ENGINE=InnoDB',
            'CREATE TABLE rol(id_rol VARCHAR(50),code VARCHAR(50),active INT) ENGINE=InnoDB',
            'CREATE TABLE business(id_business VARCHAR(50) PRIMARY KEY,name VARCHAR(200)) ENGINE=InnoDB',
            'CREATE TABLE login(id_login VARCHAR(50) PRIMARY KEY,email VARCHAR(254) UNIQUE,password VARCHAR(300)) ENGINE=InnoDB',
            'CREATE TABLE registration_account(id_login VARCHAR(50),id_business VARCHAR(50)) ENGINE=InnoDB',
            'CREATE TABLE qa_audit(id INT AUTO_INCREMENT PRIMARY KEY,metadata JSON) ENGINE=InnoDB',
            "INSERT INTO rol VALUES('admin','admin',1)"
        ])await setup.query(sql);
    }finally{await setup.end();}
    const db=new Sequelize('medsync_legal_test','root','isolated-test-only',{host:'127.0.0.1',port,dialect:'mysql',logging:false,pool:{max:2,min:0}});
    const {LegalRegistrationService}=require('../../src/services/registration/legalRegistration.service');
    const {RegistrationService}=require('../../src/services/registration/registration.service');
    let now=Date.now(),postMode='success',tokenCalls=0,recordCalls=0;
    const html=Buffer.from('<h1>Isolated legal document</h1>'),contentHash=createHash('sha256').update(html).digest('hex');
    const applicationId=randomUUID(),snapshotToken=randomUUID();
    const expiresAt=new Date(now+3600000).toISOString();
    const docs=['terminos_y_condiciones','aviso_de_privacidad'].map((documentKey,i)=>({documentId:randomUUID(),documentKey,documentVersionId:randomUUID(),version:'1.0.0',title:documentKey,requiredAction:i?'acknowledge':'accept',contentHash,blocking:true,requireReacceptance:true,deadline:null,artifacts:{html:{url:'https://storage.example/'+i,expiresAt,contentType:'text/html',size:html.length,sha256:contentHash}}}));
    const manifest={applicationId,documentSetKey:'registration',revision:randomUUID(),snapshotToken,expiresAt,documents:docs};
    const received=new Map();let firstPayload,artifactDownloads=0,completeArtifactDownloads;
    const firstArtifactDownloads=new Promise(resolve=>{completeArtifactDownloads=resolve;});
    const fakeFetch=async(url,options={})=>{
        url=String(url);
        if(url.startsWith('https://storage.example/')){
            artifactDownloads++;
            await firstArtifactDownloads;
            return new Response(html);
        }
        if(url.includes('/document-sets/registration'))return Response.json(manifest);
        if(url.endsWith('/oauth/token')){tokenCalls++;assert.equal(options.body.get('client_secret'),'synthetic-secret');assert.equal(options.body.get('resource'),'http://localhost:3017');assert.equal(options.body.get('audience'),'legal-api');return Response.json({access_token:'synthetic.token',token_type:'Bearer',expires_in:300,scope:'legal.integration.acceptances.create'});}
        if(url.endsWith('/integrations/evidence')){
            recordCalls++;assert.equal(new Headers(options.headers).get('authorization'),'Bearer synthetic.token');const payload=JSON.parse(options.body);
            assert.equal(payload.snapshotToken,snapshotToken);assert.ok(payload.subjectId);assert.ok(payload.organizationId);assert.equal(payload.confirmations.length,2);
            if(!firstPayload)firstPayload=payload;else assert.deepEqual(payload,firstPayload,'Retry must preserve the original identity, timestamp, snapshot and confirmations');
            if(postMode==='unavailable')return Response.json({}, {status:503});
            if(!received.has(payload.idempotencyKey))received.set(payload.idempotencyKey,{evidenceId:randomUUID(),snapshotToken,recorded:true,occurredAt:payload.occurredAt,receivedAt:new Date().toISOString(),authenticationMethod:'collector_attested'});
            if(postMode==='lost-reply'){postMode='success';throw Error('Synthetic lost response');}
            return Response.json(received.get(payload.idempotencyKey));
        }
        throw Error('Unexpected network destination');
    };
    const env={LEGAL_API_URL:'http://localhost:3017',HEMIA_ID_URL:'http://localhost:4000',LEGAL_APPLICATION_ID:applicationId,HEMIA_CLIENT_ID:'medsync-backend',HEMIA_CLIENT_SECRET:'synthetic-secret',LEGAL_DOCUMENT_ORIGINS:'https://storage.example'};
    const originalFetch=global.fetch;
    global.fetch=fakeFetch;
    const legal=new LegalRegistrationService(db,{env,clock:()=>now});
    try{
        await legal.ready();
        const secret=randomBytes(32).toString('hex'),pendingContext=legal.context(secret);
        await new Promise(resolve=>setImmediate(resolve));
        const startedBeforeCompletion=artifactDownloads;
        completeArtifactDownloads();
        const context=await pendingContext;
        assert.equal(startedBeforeCompletion,2,'Start both downloads before either completes');
        const input={account:{first_name:'Synthetic',last_name:'Account',email:'synthetic@example.test',telephone:'',password:'A synthetic testing phrase'},business:{name:'Synthetic clinic'},legalContext:context.legalContext,
            legalAcceptances:context.legalDocuments.map(d=>({documentKey:d.documentKey,versionId:d.versionId,acknowledged:true}))};
        assert.throws(()=>legal.prepare({...input,legalContext:input.legalContext+'x'},secret),e=>e.code==='LEGAL_VERSION_STALE');
        assert.throws(()=>legal.prepare(input,'different-owner'),e=>e.code==='LEGAL_VERSION_STALE');
        assert.throws(()=>legal.prepare({...input,legalAcceptances:input.legalAcceptances.slice(1)},secret),e=>e.code==='LEGAL_VERSION_STALE');
        assert.throws(()=>legal.prepare({...input,legalAcceptances:input.legalAcceptances.map(d=>({...d,acknowledged:false}))},secret),e=>e.code==='LEGAL_VERSION_STALE');
        const prepared=legal.prepare(input,secret);assert.deepEqual(prepared.confirmations.map(c=>c.action),['accept','acknowledge']);
        const foreign=new LegalRegistrationService(db,{env:{...env,LEGAL_DOCUMENT_ORIGINS:'https://other.example'},clock:()=>now});await assert.rejects(foreign.context(secret));
        const service=new RegistrationService(db,{legal,identityEnabled:()=>true,key:()=>Buffer.from(process.env.REGISTRATION_HMAC_KEY,'hex'),loadBlocklist:async()=>new Set(['blocked-password'])});
        service.provisioning={business:async(v,transaction)=>db.query('INSERT INTO business VALUES(:id,:name)',{replacements:{id:v._id_business,name:v._name},transaction}),defaults:async()=>{},administrator:async(v,transaction)=>db.query('INSERT INTO login VALUES(:id,:email,:password)',{replacements:{id:v._id_login,email:v._email,password:v._password},transaction})};
        service.audit={record:async(_action,v,{transaction})=>db.query('INSERT INTO qa_audit(metadata) VALUES(:metadata)',{replacements:{metadata:JSON.stringify(v.metadata)},transaction})};
        const attempt={id:randomUUID(),secret};const created=await service.create(input,attempt);assert.equal(created.status,201);
        const query=(sql,replacements={})=>db.query(sql,{replacements,type:QueryTypes.SELECT});
        const [event]=await query('SELECT * FROM registration_outbox');const payload=typeof event.legal_evidence_payload==='string'?JSON.parse(event.legal_evidence_payload):event.legal_evidence_payload;
        assert.equal(payload.subjectId,created.data.idLogin);assert.equal(payload.organizationId,created.data.idBusiness);assert.equal(payload.idempotencyKey,event.event_id);
        const privateState=JSON.stringify(event);for(const value of [input.account.email,input.account.password,secret,env.HEMIA_CLIENT_SECRET])assert.ok(!privateState.includes(value));
        now+=3700000;assert.throws(()=>legal.prepare(input,secret));assert.equal((await service.create(input,attempt)).status,200,'A committed replay remains a receipt after the displayed snapshot expires');now-=3700000;
        assert.equal((await query('SELECT * FROM registration_outbox')).length,1);
        postMode='unavailable';await legal.flush(1);assert.equal((await query('SELECT * FROM registration_outbox'))[0].processed_at,null);
        await db.query('UPDATE registration_outbox SET legal_retry_at=NULL');postMode='lost-reply';await legal.flush(1);assert.equal(received.size,1);
        await db.query('UPDATE registration_outbox SET legal_retry_at=NULL');await legal.flush(1);
        const [done]=await query('SELECT * FROM registration_outbox');assert.ok(done.processed_at);assert.equal(done.legal_evidence_id,received.get(payload.idempotencyKey).evidenceId);assert.equal(tokenCalls,1);assert.equal(recordCalls,3);
        const originalAdmin=service.provisioning.administrator;service.provisioning.administrator=async()=>{throw Error('Synthetic transaction failure');};
        const failed=await service.create({...input,account:{...input.account,email:'rollback@example.test'}},{id:randomUUID(),secret});assert.equal(failed.status,503);service.provisioning.administrator=originalAdmin;
        assert.equal((await query('SELECT * FROM business')).length,1);assert.equal((await query('SELECT * FROM registration_outbox')).length,1);
        console.log('PASS isolated MySQL: additive migration, current document hashes, signed snapshot/owner validation, explicit confirmations, atomic account and evidence queue, rollback, replay after expiry, token audience, network failure, lost response and idempotent receipt. No shared accounts or acceptances.');
    }finally{global.fetch=originalFetch;await db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

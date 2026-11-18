'use strict';
// Real router/service/SQL on a disposable loopback database. Auth/CSRF gates are simulated here;
// this suite is not authenticated acceptance in the shared test environment. Never loads .env.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const mysql=require('mysql2/promise'),{Sequelize}=require('sequelize');
const {apply}=require('../migrations/nc1-identity');
const {install}=require('../migrations/nc4-catalogs');
const {buildRelease}=require('../../src/domain/sisCatalog/release');
const {installRelease}=require('../../src/domain/sisCatalog/installRelease');
const {createService}=require('../../src/domain/identity/service');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const family='sis.establishments',code='QATEST00001';
const ref=releaseId=>({family,releaseId,code});

test('CLUES-F1/CAT-O1: isolated MySQL and HTTP contract',{skip:process.env.NC1_ISOLATED_QA!=='1'},async t=>{
    const database='nc1_qa_clues_'+Date.now();
    const options={host:'127.0.0.1',port:33381,user:'root',password:'nc1-synthetic-only'};
    const conn=await mysql.createConnection(options);
    await conn.query('CREATE DATABASE '+database+' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await conn.changeUser({database});
    // Three connections are intentional: these tests must contend on actual InnoDB row/range locks.
    const db=new Sequelize(database,options.user,options.password,{host:options.host,port:options.port,dialect:'mysql',logging:false,pool:{max:3,min:0},timezone:'+00:00'});
    let server;
    try {
        await conn.query('CREATE TABLE business(id_business VARCHAR(50) PRIMARY KEY)');
        await conn.query('CREATE TABLE person(id_person VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50))');
        await conn.query('CREATE TABLE doctor_professional_profile(id_doctor_professional_profile VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50))');
        await apply(conn,{isolated:true}); await install(conn,()=>{});
        await conn.query("INSERT INTO business VALUES ('qa-a'),('qa-b')");
        const svc=createService(db);
        const create=(identity,key,business='qa-a')=>svc.save('establishment',null,business,'qa-actor',identity,0,false,key);
        const edit=(id,identity,revision)=>svc.save('establishment',id,'qa-a','qa-actor',identity,revision);
        const count=async()=>Number((await conn.query('SELECT COUNT(*) AS n FROM care_establishment'))[0][0].n);
        const release=async(n,extra=[])=>{
            const manifest={releaseId:'qa-clues-'+n,family,sourceCatalogName:'Synthetic isolated QA ONLY',sourceUrl:null,
                sourceVersion:'QA '+n,downloadedAt:'2026-01-01T00:00:00.000Z',sha256:String(n).repeat(64),encoding:'utf-8',
                validFrom:(2000+n)+'-01-01',validTo:null,validityBasis:'download_date',provenance:'official',status:'staged',verifiedAt:null,columnMapping:{}};
            const rows=[{code,label:'Unidad oficial QA '+n,attributes:{clues:code,nombre_unidad:'Unidad oficial QA '+n,en_operacion:'1',institucion:'QA',tipo_unidad:'1',id_entidad_federativa:'09',tip_abreviacion:'CONS',sub_abreviacion:'QA'}},
                {code:'QATEST00002',label:'No operativa QA',attributes:{en_operacion:'3'}},...extra];
            await installRelease(conn,buildRelease(manifest,rows),{verify:true,sourceSha256:manifest.sha256});
        };
        await release(1);
        const original={displayName:'Nombre local QA',cluesRef:ref('qa-clues-1'),active:true,validFrom:null,validTo:null};
        let unit;
        await t.test('same key is order-independent; response loss and PATCH preserve original fingerprint',async()=>{
            unit=await create(original,'create-original');
            assert.equal(unit.catalogAttributes.nombre_unidad,'Unidad oficial QA 1');
            assert.equal(unit.catalogChecks[0].source.sha256,'1'.repeat(64));
            assert.equal(unit.displayName,original.displayName);
            const again=await create(Object.fromEntries(Object.entries(original).reverse()),'create-original');
            assert.equal(again.id,unit.id); assert.equal(again.replayed,true); assert.equal(again.revision,1);
            const [before]=await conn.query('SELECT request_hash FROM care_establishment WHERE id_care_establishment=?',[unit.id]);
            await edit(unit.id,{displayName:'Edición posterior',active:false},1);
            const replay=await create(original,'create-original');
            assert.equal(replay.id,unit.id); assert.equal(replay.displayName,'Edición posterior'); assert.equal(replay.active,false);assert.equal(replay.revision,2);
            const [after]=await conn.query('SELECT request_hash FROM care_establishment WHERE id_care_establishment=?',[unit.id]);
            assert.equal(after[0].request_hash,before[0].request_hash);
            assert.ok(!JSON.stringify(replay).includes('request_hash'));assert.ok(!JSON.stringify(replay).includes('create-original'));
            for(const patch of [{active:false},{displayName:'Otra intención'},{cluesRef:null},{validFrom:'2020-01-01'}])
                await assert.rejects(()=>create({...original,...patch},'create-original'),{code:'IDEMPOTENCY_KEY_REUSED',status:409});
            assert.equal(await count(),1);
        });
        await t.test('real concurrent attempts serialize; a key is scoped to the account',async()=>{
            const body={displayName:'Mismo nombre permitido',cluesRef:null};
            const results=await Promise.all(Array.from({length:3},()=>create(body,'concurrent-key')));
            assert.equal(new Set(results.map(x=>x.id)).size,1);assert.equal(results.filter(x=>x.replayed).length,2);
            const other=await create(body,'concurrent-key','qa-b');assert.notEqual(other.id,results[0].id);
            await assert.rejects(()=>svc.read('establishment',results[0].id,'qa-b'),{status:404});
            const raced=await Promise.allSettled([create(body,'different-payload'),create({...body,active:false},'different-payload')]);
            assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);assert.equal(raced.find(x=>x.status==='rejected').reason.code,'IDEMPOTENCY_KEY_REUSED');
        });
        await t.test('retry waits for a late commit; rollback does not consume the operation',async()=>{
            let entered,finish;const gate=new Promise(r=>{finish=r;}),started=new Promise(r=>{entered=r;});
            const body={displayName:'Commit tardío QA'};
            const first=db.transaction(async transaction=>{const saved=await svc.saveIn(transaction,'establishment',null,'qa-a','qa-actor',body,0,false,'late-commit-key');entered();await gate;return saved;});
            await started;let settled=false;const retry=create(body,'late-commit-key').finally(()=>{settled=true;});
            try {await pause(120);assert.equal(settled,false);}finally{finish();}
            const [a,b]=await Promise.all([first,retry]);assert.equal(a.id,b.id);assert.equal(b.replayed,true);
            const before=await count();
            await assert.rejects(()=>db.transaction(async transaction=>{await svc.saveIn(transaction,'establishment',null,'qa-a','qa-actor',body,0,false,'rollback-key');throw Error('rollback QA');}),/rollback QA/);
            assert.equal(await count(),before);assert.equal((await create(body,'rollback-key')).revision,1);
        });
        await t.test('exact current lookup and historical attributes do not infer absence from pagination',async()=>{
            // All these name matches sort before the exact CLUES, which is outside the first text-search page.
            const noise=Array.from({length:35},(_,i)=>({code:'QAABC'+String(i).padStart(6,'0'),label:'Mención de '+code,attributes:{en_operacion:'1'}}));
            await release(2,noise);
            const old=await svc.read('establishment',unit.id,'qa-a');const view=await svc.view(old.data,old.revision,old.updatedAt);
            assert.equal(view.catalogChecks[0].code,'RELEASE_NOT_EFFECTIVE');assert.equal(view.catalogAttributes.nombre_unidad,'Unidad oficial QA 1');
            assert.equal((await svc.catalogs.search(family,{q:code})).items.some(x=>x.ref.code===code),false);
            const current=await svc.catalogs.search(family,{exactCode:code});
            assert.equal(current.item.ref.releaseId,'qa-clues-2');assert.equal(current.item.check.result,'valid');assert.equal(current.item.attributes.nombre_unidad,'Unidad oficial QA 2');
            assert.equal((await svc.catalogs.search(family,{exactCode:'QAMISS00001'})).item,null);
            const inactive=await svc.catalogs.search(family,{exactCode:'QATEST00002'});assert.equal(inactive.item.check.code,'CLUES_NOT_OPERATING');
            assert.equal(inactive.item.attributes.en_operacion,'3');
            const manual=await create({displayName:'Manual QA',cluesRef:{family,code}},'manual-key');assert.equal(manual.catalogAttributes,null);assert.equal(manual.catalogValidation,'unverified');
            const noRef=await create({displayName:'Sin CLUES QA'},'no-clues-key');assert.equal(noRef.catalogAttributes,null);
            await assert.rejects(()=>create({...original,catalogAttributes:{institucion:'inventada'}},'readonly-key'),{code:'IDENTITY_READONLY_OR_UNKNOWN'});
            await assert.rejects(()=>svc.catalogs.search(family,{exactCode:code,offset:0}),{status:400});
            await assert.rejects(()=>svc.catalogs.search('sis.country',{exactCode:code}),{status:400});
            await edit(unit.id,{cluesRef:ref('qa-clues-2')},2);
            const replay=await create(original,'create-original');assert.equal(replay.id,unit.id);assert.equal(replay.revision,3);
            assert.equal(replay.displayName,'Edición posterior');assert.equal(replay.cluesRef.releaseId,'qa-clues-2');
            await assert.rejects(()=>edit(unit.id,{cluesRef:ref('qa-clues-2')},2),{code:'IDENTITY_CONFLICT'});
        });
        await t.test('catalog activation waits for a validated write; stale confirmations are rejected',async()=>{
            // A manual ref exists first; promoting it to a current catalog ref takes the release range lock.
            const target=await create({displayName:'Release race',cluesRef:{family,code}},'release-race-key');
            let entered,finish;const gate=new Promise(r=>{finish=r;}),started=new Promise(r=>{entered=r;});
            const write=db.transaction(async transaction=>{const saved=await svc.saveIn(transaction,'establishment',target.id,'qa-a','qa-actor',{cluesRef:ref('qa-clues-2')},1);entered();await gate;return saved;});
            await started;let activated=false;const activation=release(3).then(()=>{activated=true;});
            try{await pause(120);assert.equal(activated,false);}finally{finish();}
            await Promise.all([write,activation]);
            const stale=await create({displayName:'Comprobación obsoleta',cluesRef:{family,code}},'stale-confirm-key');
            await assert.rejects(()=>edit(stale.id,{cluesRef:ref('qa-clues-2')},1),{status:409,code:'CATALOG_RELEASE_CHANGED'});
            assert.equal((await svc.read('establishment',stale.id,'qa-a')).revision,1);
            const saved=await edit(stale.id,{cluesRef:ref('qa-clues-3')},1);assert.equal(saved.catalogValidation,'verified');
            const replay=await create(original,'create-original');assert.equal(replay.revision,3);assert.equal(replay.cluesRef.releaseId,'qa-clues-2');
            assert.equal(replay.catalogValidation,'unverified');
        });
        await t.test('HTTP retries enforce session, operational tenant, permission and CSRF before service',async()=>{
            const express=require('express'),module={exports:{}};let writes=0;
            const stub={
                '../../auth/authenticate':{Auth:(req,res,next)=>{if(req.headers['x-qa-session']!=='yes')return res.sendStatus(401);req.tokenDecode={id_login:'qa-actor',id_business:'qa-a'};next();}},
                '../../middleware/requireTenantOperational.middleware':(req,res,next)=>req.headers['x-qa-operational']==='no'?res.sendStatus(403):next(),
                '../../middleware/requirePermission.middleware':{requirePermission:()=>((req,res,next)=>req.headers['x-qa-permission']==='no'?res.sendStatus(403):next())},
                '../../middleware/csrf.middleware':{csrfProtection:()=>((req,res,next)=>req.headers['x-qa-csrf']==='yes'?next():res.sendStatus(403))},
                '../../util/tenant':{getBusinessIdFromToken:token=>token.id_business},'../../util/effectivePermissions':{hasPermission:async()=>false},
                '../../db/Sequelize.connection':db,'../../Dao/mysql/identity.dao':{...svc,save:(...args)=>{writes++;return svc.save(...args);}}
            };
            vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/routes/mysql/identity.js'),'utf8'),{module,require:name=>stub[name]||require(name)});
            const app=express();app.use(express.json());app.use('/api/identity',module.exports);
            server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
            const base='http://127.0.0.1:'+server.address().port+'/api/identity';
            const headers={'content-type':'application/json','x-qa-session':'yes','x-qa-csrf':'yes','Idempotency-Key':'http-loss-key'};
            const body=JSON.stringify({identity:{displayName:'HTTP perdido QA',cluesRef:ref('qa-clues-3')},expectedRevision:0});
            const post=(over={},value=body)=>fetch(base+'/establishments',{method:'POST',headers:{...headers,...over},body:value});
            // Discard the first response body, then send the same HTTP request again.
            const lost=await post();assert.equal(lost.status,200);await lost.body.cancel();
            const replay=await post(),data=(await replay.json()).data;assert.equal(data.replayed,true);assert.equal(data.revision,1);assert.equal(replay.headers.get('cache-control'),'no-store');
            const reached=writes;
            for(const [header,value,status] of [['x-qa-session','no',401],['x-qa-operational','no',403],['x-qa-permission','no',403],['x-qa-csrf','no',403]])assert.equal((await post({[header]:value})).status,status);
            assert.equal(writes,reached);
            assert.equal((await post({'Idempotency-Key':'bad key'})).status,400);
            assert.equal((await post({},JSON.stringify({identity:{displayName:'Changed'},expectedRevision:0}))).status,409);
            const exact=await fetch(base+'/catalogs/'+family+'?exactCode='+code,{headers});assert.equal((await exact.json()).data.item.ref.releaseId,'qa-clues-3');
            assert.equal((await fetch(base+'/catalogs/'+family+'?exactCode='+code)).status,401);
            assert.equal((await post({},JSON.stringify({identity:{displayName:'No body tenant'},expectedRevision:0,id_business:'qa-b'}))).status,400);
        });
        await t.test('legacy clients and invalid keys remain explicit',async()=>{
            const body={displayName:'Legacy sin clave'};
            assert.notEqual((await create(body)).id,(await create(body)).id);
            for(const key of ['',null,'short','x'.repeat(129),'invalid key'])await assert.rejects(()=>create(body,key),{code:'IDEMPOTENCY_KEY_INVALID'});
            await assert.rejects(()=>create(body,'unknown-business','qa-missing'),{status:404});
        });
    } finally {
        if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
        await db.close();await conn.end();
    }
});

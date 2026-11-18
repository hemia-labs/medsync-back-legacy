'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCatalogs}=require('../../src/domain/identity/catalogs');
const C=require('../../src/domain/identity/contract');
const {csvPrefix}=require('../../src/domain/sisCatalog/geographicImporter');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const release=(over={})=>({family:'inegi.state',release_id:'qa-state',valid_from:'2020-01-01',valid_to:null,verified_at:new Date('2020-01-01'),status:'verified',provenance:'official',source_version:'QA only',source_url:null,...over});
const entry=(over={})=>({family:'inegi.state',release_id:'qa-state',code:'01',label:'Entidad QA',is_sentinel:0,attributes_json:{},...over});
const ref=(over={})=>({family:'inegi.state',releaseId:'qa-state',code:'01',...over});
function database(releases=[release()],entries=[entry()]) {
    const calls=[];
    return {calls,async query(sql,options){calls.push({sql,...options});const p=options.replacements;
        if(sql.startsWith('SELECT family FROM'))return releases.filter(r=>r.release_id===p.releaseId);
        if(sql.startsWith('SELECT * FROM sis_catalog_release'))return releases.filter(r=>r.family===p.family).sort((a,b)=>a.valid_from.localeCompare(b.valid_from));
        if(sql.startsWith('SELECT * FROM sis_catalog_entry'))return entries.filter(e=>e.family===p.family&&e.release_id===p.releaseId&&e.code===p.code);
        if(sql.startsWith('SELECT code,label'))return entries.filter(e=>e.family===p.family&&e.release_id===p.releaseId&&!e.is_sentinel&&(!p.q||e.label.includes(p.q)||e.code.includes(p.q))&&e.code.startsWith(p.parent)).slice(p.offset,p.offset+31);
        throw Error(sql);
    }};
}

test('residence country coherence uses merged references without inferring or changing history',async()=>{
    const cr=release({family:'sis.country',release_id:'qa-countries'});
    const countries=['142','001'].map(code=>entry({family:'sis.country',release_id:'qa-countries',code}));
    const api=createCatalogs(database([release(),cr],[entry(),...countries]));
    const country=code=>({family:'sis.country',releaseId:'qa-countries',code});
    const foreign={residence:{country:country('001'),entity:ref()}};
    await assert.rejects(()=>api.validate(foreign,{}),e=>e.status===400&&e.field==='residence.country'&&e.code==='RESIDENCE_COUNTRY_GEO_MISMATCH');
    await assert.rejects(()=>api.validate({residence:{entity:ref()}},{},foreign),{code:'RESIDENCE_COUNTRY_GEO_MISMATCH'});
    await api.validate({givenNames:'Historic unrelated edit'},{},foreign);
    await api.validate({residence:{country:country('142'),entity:ref()}},{});
    await api.validate({residence:{country:country('001')}},{});
    await api.validate({residence:{entity:ref()}},{});
    const manual={residence:{country:{family:'sis.country',code:'001'},entity:ref()}};
    await api.validate(manual,{});assert.equal((await api.view(manual,1)).catalogValidation,'unverified');
    const unknown={residence:{country:{...country('001'),releaseId:'missing'},entity:ref()}};
    await api.validate(unknown,{});
    const before=JSON.stringify(foreign),view=await api.view(foreign,1);
    assert.equal(view.catalogValidation,'unverified');assert.ok(view.qualityIssues.some(x=>x.code==='RESIDENCE_COUNTRY_GEO_MISMATCH'));
    assert.equal(JSON.stringify(foreign),before);
});

test('catalog HTTP route preserves tenant guard, bounded query, no-store and error envelope',async()=>{
    const express=require('express'),catalogs=createCatalogs(database());let searches=0,failSearch=false;
    const module={exports:{}};
    const localRequire=name=>({
        '../../auth/authenticate':{Auth:(req,res,next)=>{req.tokenDecode={id_login:'synthetic',id_business:req.headers['x-qa-business']};next();}},
        '../../middleware/requireTenantOperational.middleware':(req,res,next)=>next(),
        '../../middleware/requirePermission.middleware':{requirePermission:()=>((req,res,next)=>next())},
        '../../middleware/csrf.middleware':{csrfProtection:()=>((req,res,next)=>next())},
        '../../util/tenant':{getBusinessIdFromToken:token=>token.id_business},
        '../../util/effectivePermissions':{hasPermission:async()=>false},
        '../../db/Sequelize.connection':{},
        '../../Dao/mysql/identity.dao':{catalogs:{search:async(...args)=>{searches++;if(failSearch)throw Error('private database detail');return catalogs.search(...args);}}}
    }[name]||require(name));
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/routes/mysql/identity.js'),'utf8'),{require:localRequire,module});
    const app=express();app.use('/api/identity',module.exports);
    const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
    const base='http://127.0.0.1:'+server.address().port+'/api/identity/catalogs/';
    try {
        const denied=await fetch(base+'inegi.state');assert.equal(denied.status,403);assert.equal(searches,0);
        const headers={'x-qa-business':'synthetic'};
        const ok=await fetch(base+'inegi.state',{headers});assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'no-store');assert.equal((await ok.json()).data.items[0].ref.code,'01');
        const bad=await fetch(base+'inegi.state?offset=-1',{headers});assert.equal(bad.status,400);assert.equal((await bad.json()).data.field,'query');
        const unknown=await fetch(base+'secret.family',{headers});assert.equal(unknown.status,400);
        failSearch=true;const outage=await fetch(base+'inegi.state',{headers});assert.equal(outage.status,503);assert.ok(!(await outage.text()).includes('private database detail'));
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('official exact reference resolves while manual input never becomes verified',async()=>{
    const api=createCatalogs(database());
    const value=await api.view({residence:{entity:ref()}},1);
    assert.equal(value.catalogValidation,'verified');assert.equal(value.catalogChecks[0].label,'Entidad QA');
    const candidate=await api.view({residence:{entity:ref({releaseId:undefined})}},1);
    assert.equal(candidate.catalogValidation,'unverified');assert.equal(candidate.qualityIssues[0].code,'CATALOG_REF_CANDIDATE');
});
test('missing source is unverified; missing code and wrong family are rejected with the field',async()=>{
    const api=createCatalogs(database());
    assert.equal((await api.search('inegi.state',{code:'01',releaseId:'missing'})).check.result,'unverified');
    await assert.rejects(()=>api.validate({residence:{entity:ref({code:'02'})}},{}),e=>e.status===400&&e.field==='residence.entity'&&e.code==='CATALOG_CODE_NOT_FOUND');
    await assert.rejects(()=>api.validate({birthCountry:ref({family:'sis.country'})},{}),e=>e.code==='CATALOG_FAMILY_MISMATCH');
});
test('sentinels and nonoperating CLUES cannot be saved as references',async()=>{
    const api=createCatalogs(database([release(),release({family:'sis.establishments',release_id:'qa-clues'})],[entry({is_sentinel:1}),entry({family:'sis.establishments',release_id:'qa-clues',code:'QATEST00001',attributes_json:{en_operacion:'0'}})]));
    await assert.rejects(()=>api.validate({residence:{entity:ref()}},{}),{code:'CATALOG_SENTINEL_NOT_STORABLE'});
    await assert.rejects(()=>api.validate({cluesRef:{family:'sis.establishments',releaseId:'qa-clues',code:'QATEST00001'}},{}),{code:'CLUES_NOT_OPERATING'});
});
test('retirement/successor does not rewrite old references or claim current validation',async()=>{
    const old=release({release_id:'old'}), current=release({release_id:'current',valid_from:'2021-01-01'});
    const api=createCatalogs(database([old,current],[entry({release_id:'old'}),entry({release_id:'current'})]));
    const input={residence:{entity:ref({releaseId:'old'})}},before=JSON.stringify(input);
    const value=await api.view(input,2);assert.equal(value.catalogValidation,'unverified');assert.equal(JSON.stringify(input),before);
    assert.equal((await api.search('inegi.state')).source.releaseId,'current');
});
test('staged, synthetic and unverified retired releases never validate',async()=>{
    for(const change of [{status:'staged',verified_at:null},{provenance:'synthetic'},{status:'retired',verified_at:null}]){
        const api=createCatalogs(database([release(change)]));assert.equal((await api.view({residence:{entity:ref()}},1)).catalogValidation,'unverified');assert.equal((await api.search('inegi.state')).available,false);
    }
});
test('pagination and parent filtering are bounded and parameterized',async()=>{
    const rows=Array.from({length:40},(_,i)=>entry({code:'01'+String(i+1).padStart(3,'0'),family:'inegi.municipality',release_id:'qa-mun'}));
    const db=database([release({family:'inegi.municipality',release_id:'qa-mun'})],rows),api=createCatalogs(db);
    const first=await api.search('inegi.municipality',{parent:'01'});assert.equal(first.items.length,30);assert.equal(first.hasMore,true);
    assert.equal((await api.search('inegi.municipality',{parent:'01',offset:'30'})).items.length,10);
    await api.search('inegi.municipality',{q:"' OR 1=1 --"});assert.ok(!db.calls.at(-1).sql.includes("' OR 1=1 --"));
    for(const query of [{offset:-1},{offset:'NaN'},{offset:10001},{parent:'001'},{q:['x']}])await assert.rejects(()=>api.search('inegi.municipality',query));
    await assert.rejects(()=>api.search('sis.diagnosis',{}));
});
test('only missing schema is optional, a database outage is not called validation',async()=>{
    let code='ER_NO_SUCH_TABLE';const api=createCatalogs({query:async()=>{throw Object.assign(Error('DB'),{original:{code}});}});
    assert.equal((await api.search('inegi.state')).available,false);await api.validate({residence:{entity:ref()}},{});
    assert.equal((await api.view({residence:{entity:ref()}},1)).catalogValidation,'unverified');
    code='ECONNREFUSED';await assert.rejects(()=>api.validate({residence:{entity:ref()}},{}));
});
test('transaction is used for validation and server quality reads',async()=>{
    const db=database(),transaction={qa:true},api=createCatalogs(db);await api.validate({residence:{entity:ref()}},transaction);await api.view({residence:{entity:ref()}},1,null,transaction);
    assert.ok(db.calls.every(call=>call.transaction===transaction));
});
test('entity/locality incompatibility is rejected even without a municipality',()=>{
    assert.throws(()=>C.validate('patient',{residence:{entity:{family:'inegi.state',code:'01'},locality:{family:'inegi.locality',code:'020010001'}}}),e=>e.field==='residence.locality');
});
test('INEGI parser preserves leading zeros, accents and quoted commas, ignores only unrelated suffix',()=>{
    assert.deepEqual(csvPrefix('"01","Nombre, QA","México",invalid suffix',3),['01','Nombre, QA','México']);
    assert.deepEqual(csvPrefix('"01","Un ""nombre""",x',2),['01','Un "nombre"']);
    assert.throws(()=>csvPrefix('"01","broken',2));
});

// Independent review (Claude, 2026-11-17): MySQL LOCATE is accent-sensitive even under *_ai_ci collations, and LEFT(code)
// cannot use the primary key. Search uses LIKE with escaped user text and a sargable parent prefix.
test('search is an accent-insensitive literal LIKE and the parent prefix is index-friendly',async()=>{
    const db=database([release({family:'inegi.locality',release_id:'qa-loc'})],[]),api=createCatalogs(db);
    const B='\\';
    await api.search('inegi.locality',{parent:'09010',q:'50%_off'+B});
    const {sql,replacements}=db.calls.at(-1);
    assert.doesNotMatch(sql,/LOCATE\(|LEFT\(code/);assert.match(sql,/label LIKE :like ESCAPE/);assert.match(sql,/code LIKE CONCAT\(:parent,'%'\)/);
    assert.equal(replacements.like,'%50!%!_off'+B+'%');assert.equal(replacements.parent,'09010');
    await api.search('inegi.locality',{q:'a!b'});assert.equal(db.calls.at(-1).replacements.like,'%a!!b%');
});

// Independent review (Claude, 2026-11-17): the operator must see why an import stopped (review issue, hash or target
// mismatch), not a generic failure. Only the error code is printed: never configuration or credentials.
test('install CLI reports the exact stop reason without secrets',()=>{
    const {spawnSync}=require('node:child_process'),path=require('node:path');
    const cli=path.join(__dirname,'../nc4/install-catalog.js');
    const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{PATH:process.env.PATH}});
    let r=run(['--bogus']);assert.equal(r.status,1);assert.equal(r.stderr.trim(),'UNKNOWN_ARGUMENT');
    r=run(['--dir']);assert.equal(r.status,1);assert.doesNotMatch(r.stderr,/PASSWORD|HOSTMYSQL|at /);
});


test('catalog search executes Sequelize replacement compilation before the driver',async()=>{
    const {Sequelize}=require('sequelize');
    const db=new Sequelize('qa_catalogs','qa','synthetic',{dialect:'mysql',logging:false});
    const queries=[];const OriginalQuery=db.dialect.Query;
    db.connectionManager.getConnection=async()=>({});
    db.connectionManager.releaseConnection=async()=>{};
    db.dialect.Query=class extends OriginalQuery {async run(sql){
        queries.push(sql);
        assert.doesNotMatch(sql,/:(?:family|releaseId|q|like|parent|offset)\b/,'every named replacement must reach MySQL as an escaped value');
        if(sql.includes('FROM sis_catalog_release'))return [release()];
        return [entry()];
    }};
    try {
        const api=createCatalogs(db);
        for(const q of ['', 'mexico', "Alvaro %_!' O'QA"]){const result=await api.search('inegi.state',{q,parent:'',offset:0});assert.equal(result.items[0].ref.code,'01');}
        await api.search('inegi.locality',{q:'',parent:'09010',offset:30});
        const searches=queries.filter(sql=>sql.includes('FROM sis_catalog_entry'));
        assert.equal(searches.length,4);assert.ok(searches[3].includes("CONCAT('09010','%')"));assert.ok(searches[3].includes('OFFSET 30'));
    }finally{db.dialect.Query=OriginalQuery;await db.close();}
});

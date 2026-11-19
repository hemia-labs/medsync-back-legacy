'use strict';
// Only a disposable local database. Optional --staged-dir exercises reviewed public sources privately.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const mysql=require('mysql2/promise');
const {install}=require('../migrations/nc4-catalogs');
const {buildRelease}=require('../../src/domain/sisCatalog/release');
const {installRelease}=require('../../src/domain/sisCatalog/installRelease');
const {readStagedRelease}=require('../../src/domain/sisCatalog/stagedRelease');
const {createCatalogs}=require('../../src/domain/identity/catalogs');
async function main(){
    if(process.env.NC1_CATALOG_QA_ISOLATED!=='1'||!/^\d+$/.test(process.env.NC1_CATALOG_QA_PORT||'')||process.env.NC1_CATALOG_QA_PORT==='3306')throw Error('ISOLATED_LOCAL_MYSQL_REQUIRED');
    const conn=await mysql.createConnection({host:'127.0.0.1',port:Number(process.env.NC1_CATALOG_QA_PORT),user:'root',password:'isolated-test-only',database:'medsync_nc1_catalogs_qa',timezone:'Z',namedPlaceholders:true});
    try {
        await install(conn,()=>{});
        const db={query:async(sql,{replacements})=>(await conn.query(sql,replacements))[0]},api=createCatalogs(db);
        const manifest={releaseId:'qa-nc1-country',family:'sis.country',sourceCatalogName:'Synthetic isolated test ONLY',sourceUrl:null,sourceVersion:'QA',downloadedAt:'2026-01-01T00:00:00.000Z',sha256:'a'.repeat(64),encoding:'utf-8',validFrom:'2020-01-01',validTo:null,validityBasis:'download_date',provenance:'official',status:'staged',verifiedAt:null,columnMapping:{}};
        const release=buildRelease(manifest,[{code:'001',label:'País QA',attributes:{}}]);
        const options={verify:true,sourceSha256:manifest.sha256};
        await assert.rejects(()=>installRelease(conn,release,{...options,sourceSha256:'b'.repeat(64)}),{code:'CATALOG_SOURCE_HASH_MISMATCH'});
        assert.equal((await installRelease(conn,release,options)).status,'verified');
        assert.equal((await installRelease(conn,release,options)).alreadyApplied,true);
        const changedMetadata=buildRelease({...manifest,sourceVersion:'Changed'},release.list());
        await assert.rejects(()=>installRelease(conn,changedMetadata,options),{code:'CATALOG_IMPORT_CONFLICT'});
        const ref={family:'sis.country',releaseId:manifest.releaseId,code:'001'};
        assert.equal((await api.view({birthCountry:ref},1)).catalogValidation,'verified');
        await assert.rejects(()=>api.validate({birthCountry:{...ref,code:'002'}},{}),{code:'CATALOG_CODE_NOT_FOUND'});
        assert.equal((await api.search('sis.country',{q:'País'})).items[0].ref.code,'001');
        // Independent review (Claude, 2026-11-17): accent-insensitive literal search; user wildcards never expand.
        assert.equal((await api.search('sis.country',{q:'pais qa'})).items[0]?.ref.code,'001','search without accents finds the accented label');
        for(const q of ['%','_','!','\\'])assert.equal((await api.search('sis.country',{q})).items.length,0,'literal '+q);
        await assert.rejects(()=>conn.query('UPDATE sis_catalog_entry SET label=? WHERE family=?',['changed','sis.country']));
        const conflicting=buildRelease({...manifest,releaseId:'qa-conflict',sha256:'b'.repeat(64)},[{code:'002',label:'QA conflict',attributes:{}}]);
        await assert.rejects(()=>installRelease(conn,conflicting,{verify:true,sourceSha256:'b'.repeat(64)}),{code:'CATALOG_WINDOW_CONFLICT'});
        const [[count]]=await conn.query("SELECT COUNT(*) AS n FROM sis_catalog_release WHERE release_id='qa-conflict'");assert.equal(count.n,0);
        console.log('PASS MySQL: source hash, import, idempotence, view, invalid code, search, immutable entry, overlapping window rollback');
        const index=process.argv.indexOf('--staged-dir');
        if(index!==-1){
            const dir=path.resolve(process.argv[index+1]);
            for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.manifest.json')).sort()){
                const {release:official,issues}=readStagedRelease(dir,file.replace('.manifest.json',''));
                assert.ok(issues.every(i=>i.code==='NUMERIC_CODE_CELLS'),'unreviewed source issue');
                const result=await installRelease(conn,official,{verify:true,sourceSha256:official.manifest.sha256});
                assert.equal((await api.search(official.manifest.family)).available,true);
                const selected=official.list().find(e=>!e.sentinel),r={family:official.manifest.family,releaseId:official.manifest.releaseId,code:selected.code};
                assert.equal((await api.search(r.family,{code:r.code,releaseId:r.releaseId})).check.result,'valid');
                console.log(JSON.stringify({source:result.releaseId,entries:result.entries,status:result.status}));
            }
            const municipalities=await api.search('inegi.municipality',{parent:'01'});assert.equal(municipalities.items.length,11);assert.ok(municipalities.items.every(e=>e.ref.code.startsWith('01')));
            const localities=await api.search('inegi.locality',{parent:'01001',q:'Aguascalientes'});assert.ok(localities.items.some(e=>e.ref.code==='010010001'));
            assert.equal((await api.search('renapo.nationality')).available,false);
            assert.ok((await api.search('sis.country',{q:'mexico'})).items.some(e=>e.ref.code==='142'),'MÉXICO found without accent');
            assert.ok((await api.search('inegi.municipality',{parent:'09',q:'alvaro obregon'})).items.some(e=>e.ref.code==='09010'),'Álvaro Obregón found without accent');
            assert.ok((await api.search('inegi.locality',{parent:'09010'})).items.every(e=>e.ref.code.startsWith('09010')));
            console.log('PASS official snapshots private/local only; geographic hierarchy, leading zeros and absent RENAPO');
        }
    } finally {await conn.end();}
}
main().catch(e=>{console.error(e.code||e.message,e.sqlMessage||'',e.stack);process.exitCode=1;});

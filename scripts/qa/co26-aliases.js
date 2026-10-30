'use strict';
const assert=require('node:assert/strict');
const {normalizeAlias,GLOBAL_ALIASES}=require('../../src/domain/odontogram/aliases');
const rows=new Map(),events=[];
const id=require.resolve('../../src/db/Sequelize.connection');
require.cache[id]={id,filename:id,loaded:true,exports:{
 async transaction(work){const before=new Map(rows);try{return await work({});}catch(error){rows.clear();for(const [key,value]of before)rows.set(key,value);throw error;}},
 async query(sql,options){assert.equal(options.logging,false);const v=options.replacements;
  if(sql.startsWith('SELECT id_business'))return [{id_business:v.business}];
  if(sql.startsWith('SELECT step'))return [{step:'odontogram_alias'}];
  if(sql.startsWith('SELECT alias FROM'))return [...rows.values()].filter(row=>row.scope_kind==='tenant'&&row.alias===v.alias&&row.active);
  if(sql.startsWith('SELECT scope_key'))return [...rows.values()].filter(row=>[v.global,v.tenant].includes(row.scope_key)).sort((a,b)=>(a.scope_key+a.alias).localeCompare(b.scope_key+b.alias));
  if(sql.startsWith('SELECT *'))return rows.has(v.scope+':'+v.alias)?[rows.get(v.scope+':'+v.alias)]:[];
  if(sql.startsWith('INSERT INTO odontogram_alias(')){rows.set(v.scope+':'+v.alias,{scope_key:v.scope,scope_kind:v.scope==='global'?'global':'tenant',id_business:v.business,alias:v.alias,target:v.target,active:v.active,version:v.version});return [];}
  if(sql.startsWith('INSERT INTO odontogram_alias_event')){events.push(v);return [];}
  throw Error('Unexpected alias SQL');
 }
}};
const aliases=require('../../src/services/odontogramAliases.service');
(async()=>{
 assert.equal(normalizeAlias('  RésiNa  '),'resina');assert.equal(GLOBAL_ALIASES.resina,'res');
 for(const word of ['18','car mo','__proto__','car;'])assert.throws(()=>normalizeAlias(word));
 const initial=await aliases.state('one');
 for(const word of ['car','resina','ok','pres','note'])await assert.rejects(()=>aliases.save('one','admin',{alias:word,target:'car',expected_version:initial.alias_version}),/reservado/);
 const saved=await aliases.save('one','admin',{alias:'deterioro',target:'car',expected_version:initial.alias_version});
 assert.equal(saved.aliases.deterioro,'car');assert.notEqual(saved.alias_version,initial.alias_version);
 assert.equal((await aliases.state('two')).aliases.deterioro,undefined);
 await assert.rejects(()=>aliases.save('one','admin',{alias:'deterioro',target:'res',expected_version:initial.alias_version}),e=>e.status===409);
 const changed=await aliases.save('one','admin',{alias:'deterioro',target:'res',expected_version:saved.alias_version});assert.equal(changed.aliases.deterioro,'res');
 const deleted=await aliases.save('one','admin',{alias:'deterioro',target:null,expected_version:changed.alias_version});assert.equal(deleted.aliases.deterioro,undefined);assert.equal(events.length,3);
 rows.set('tenant:one:resina',{scope_key:'tenant:one',scope_kind:'tenant',id_business:'one',alias:'resina',target:'car',active:1,version:1});
 const conflict=await aliases.state('one');assert.equal(conflict.aliases.resina,'res');assert.equal(conflict.conflicts.length,1);
 assert.equal((await aliases.save('one','admin',{alias:'resina',target:null,expected_version:conflict.alias_version})).conflicts.length,0);
 let globals=await aliases.state(null);
 await assert.rejects(()=>aliases.saveGlobal('platform',{alias:'resina',target:'car',expected_version:globals.alias_version}),/protegidos/);
 const local=await aliases.state('one');await aliases.save('one','admin',{alias:'localonly',target:'car',expected_version:local.alias_version});
 await assert.rejects(()=>aliases.saveGlobal('platform',{alias:'localonly',target:'car',expected_version:globals.alias_version}),e=>e.status===409);
 globals=await aliases.saveGlobal('platform',{alias:'globalonly',target:'car',expected_version:globals.alias_version});
 assert.equal((await aliases.state('two')).aliases.globalonly,'car');
 const localAfterGlobal=await aliases.state('one');await assert.rejects(()=>aliases.save('one','admin',{alias:'globalonly',target:'res',expected_version:localAfterGlobal.alias_version}),e=>e.status===422);
 globals=await aliases.saveGlobal('platform',{alias:'globalonly',target:'res',expected_version:globals.alias_version});assert.equal(globals.global_aliases.globalonly,'res');
 globals=await aliases.saveGlobal('platform',{alias:'globalonly',target:null,expected_version:globals.alias_version});assert.equal(globals.global_aliases.globalonly,undefined);
 console.log('PASS aliases: normalization, reserved/global protection, tenant isolation, expected version, logical deletion/audit and historical conflict resolution. Fake DB only.');
})().catch(error=>{console.error(error);process.exitCode=1;});

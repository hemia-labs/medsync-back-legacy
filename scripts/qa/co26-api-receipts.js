'use strict';
const assert = require('node:assert/strict');
const D = require('../../src/domain/odontogram/operations');
const aliasId=require.resolve('../../src/services/odontogramAliases.service');
require.cache[aliasId]={id:aliasId,filename:aliasId,loaded:true,exports:{state:async()=>({aliases:{},alias_version:'a'.repeat(64),conflicts:[]})}};
const prefId=require.resolve('../../src/services/odontogramPreferences.service');require.cache[prefId]={id:prefId,filename:prefId,loaded:true,exports:{state:async()=>({schema_ready:true,valid:true,traversal:{}})}};
const id = require.resolve('../../src/db/Sequelize.connection');
let committed=0,rolledBack=0;
require.cache[id]={id,filename:id,loaded:true,exports:{transaction:async()=>({finished:false,async commit(){this.finished=true;committed++;},async rollback(){this.finished=true;rolledBack++;}})}};
const dao=require('../../src/Dao/mysql/odontogramV2.dao');
let snapshot=D.emptyChart('mixed'), mode='v2', projections=0;
const receipts=new Map(),operations=new Map(),versions=new Map([[0,JSON.stringify(snapshot)]]);
dao.query=async(sql,values,transaction)=>{
  if(/FROM person/.test(sql))return values.business==='tenant'&&values.patient==='patient'?[{id_person:'patient'}]:[];
  if(/SELECT odontogram_mode/.test(sql))return [{odontogram_mode:mode}];
  if(/SELECT \* FROM odontogram_v2_chart/.test(sql))return values.business==='tenant'&&values.id==='chart'?[{id_chart:'chart',id_person:'patient',snapshot_json:JSON.stringify(snapshot)}]:[];
  if(/SELECT status FROM odontogram_v2_chart/.test(sql))return [{status:snapshot.status}];
  if(/SELECT \* FROM odontogram_v2_batch/.test(sql))return receipts.has(values.batch)?[receipts.get(values.batch)]:[];
  if(/SELECT client_op_id FROM odontogram_v2_operation/.test(sql))return operations.has(values.op)?[{client_op_id:values.op}]:[];
  if(/SELECT event_json,revision,actor/.test(sql))return operations.has(values.op)?[operations.get(values.op)]:[];
  if(/SELECT snapshot_json FROM odontogram_v2_revision/.test(sql))return versions.has(values.revision)?[{snapshot_json:versions.get(values.revision)}]:[];
  if(/INSERT INTO odontogram_v2_batch/.test(sql)){assert.ok(transaction);receipts.set(values.batch,{actor:values.actor,id_chart:values.id,request_hash:values.hash,result_json:values.result});return [];}
  if(/INSERT INTO odontogram_v2_operation/.test(sql)){assert.ok(transaction);operations.set(values.op,{event_json:values.event,revision:values.revision,actor:values.actor});return [];}
  throw Error('Unimplemented isolated SQL: '+sql.slice(0,70));
};
dao.project=async(business,chart,actor,next,transaction)=>{assert.ok(transaction);projections++;snapshot=D.clone(next);versions.set(next.revision,JSON.stringify(next));};
(async()=>{
 const batch={batch_id:'batch',base_revision:0,generation:1,catalog_version:D.CATALOG_VERSION,alias_version:'a'.repeat(64),ops:[{client_op_id:'op',type:'note.set',tooth:16,text:'Saved'}]};
 const first=await dao.operations('tenant','actor','chart',batch);assert.equal(first.revision,1);assert.equal(projections,1);
 snapshot.status='finalized';snapshot.generation++;mode='v2_readonly';
 const retry=await dao.operations('tenant','actor','chart',batch);assert.deepEqual(retry,first);assert.equal(projections,1);
 await assert.rejects(()=>dao.operations('tenant','actor','chart',{...batch,ops:[{...batch.ops[0],text:'Changed'}]}),e=>e.status===409);
 await assert.rejects(()=>dao.operations('tenant','other-actor','chart',batch),e=>e.status===409);
 await assert.rejects(()=>dao.operations('other-tenant','actor','chart',batch),e=>e.status===404);
 await assert.rejects(()=>dao.operations('tenant','actor','chart',{...batch,batch_id:'new'}),e=>e.code==='CO26_MODE');
 snapshot.status='active';mode='v2';
 await assert.rejects(()=>dao.operations('tenant','actor','chart',{...batch,batch_id:'mixed',generation:snapshot.generation}),e=>e.code==='CO26_MIXED_BATCH');
 assert.equal((await dao.read('tenant','chart',0)).teeth[16].note,'');
 assert.equal((await dao.read('tenant','chart',1)).teeth[16].note,'Saved');
 assert.equal(committed,2);assert.ok(rolledBack>=4);
 console.log('PASS DAO receipts: same batch after closure/readonly, content/actor reuse, tenant isolation, mixed batch rejected, exact historical snapshots. Fake SQL only.');
})().catch(error=>{console.error(error);process.exitCode=1;});

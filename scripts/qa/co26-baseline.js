'use strict';
const assert=require('node:assert/strict');
const id=require.resolve('../../src/db/Sequelize.connection');require.cache[id]={id,filename:id,loaded:true,exports:{}};
const dao=require('../../src/Dao/mysql/odontogramV2.dao');
const {sequence}=require('../../src/domain/odontogram/dentalContract');
let legacy=[{id_business:'tenant',id_odontogramv1:'legacy',id_person:'patient',type:'permanent',active:1,created_by:'original-author',created_at:'2020-01-02'}],projections=[];
dao.query=async(sql,values)=>{
 if(sql.includes('FROM odontogramv1 o'))return legacy;
 if(sql.includes('FROM cat_tooth ct JOIN cat_type_tooth'))return sequence(values.type).map(sec=>({sec,id_tooth:'existing-'+sec}));
 if(sql.includes('FROM odontogramDetailv1 d'))return [{sec:16,treatment:'Texto previo: caries MO, no clasificar automáticamente.'}];
 throw Error('Unexpected baseline query');
};
dao.project=async(business,chart,actor,snapshot,transaction,create,patient)=>projections.push({business,chart,actor,snapshot,create,patient});
(async()=>{
 assert.equal(await dao.baseline('tenant','migration-actor',{}),1);
 const snapshot=projections[0].snapshot;
 assert.equal(snapshot.teeth[16].note,'Texto previo: caries MO, no clasificar automáticamente.');
 assert.equal(snapshot.teeth[16].findings.length,0);assert.equal(snapshot.teeth[16].reviewed_revision,null);
 assert.equal(snapshot.created_by,'original-author');assert.equal(snapshot.baseline.original_created_at,'2020-01-02');
 assert.equal(snapshot.baseline.history_before_baseline,false);
 assert.equal(projections[0].chart,'legacy');assert.equal(snapshot.revision,0);
 legacy=[...legacy,{...legacy[0],id_odontogramv1:'duplicate'}];await assert.rejects(()=>dao.baseline('tenant','actor',{}),/varios odontogramas activos/);
 legacy=[{...legacy[0],id_business:'foreign'}];await assert.rejects(()=>dao.baseline('tenant','actor',{}),/inconsistente/);
 console.log('PASS baseline: legacy IDs/authorship/date and literal notes retained, no inferred findings/review/history, duplicate active and tenant inconsistency rejected. Fake SQL only.');
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {mergeDental,sourceKey,contentProjection}=require('../../src/domain/odontogram/planDental');
const source={id_chart:'chart',finding_id:null,revision:2,source_key:sourceKey('chart',null,'55'),context:{label:'Pieza 55'}};
const previous=[{tooth_number:'55',surfaces:'MO',manual:true,sources:[source]}];
const options={revision:3,canReadOdontogram:true,resolveSource:async()=>({context:{label:'Server label'}})};
test('omission, teeth-only and redacted/empty sources preserve existing provenance and faces',async()=>{
 for(const body of [{},{teeth:['55']},{teeth:['55'],tooth_details:[{tooth_number:'55',sources:[],sources_redacted:true}]}]){
  const result=await mergeDental(previous,body,{...options,canReadOdontogram:false,resolveSource:()=>{throw Error('Must not revalidate saved origins');}});
  assert.equal(result.changed,false);assert.deepEqual(result.details,previous);
 }
});
test('rich-only derives teeth; canonical faces and explicit null differ from omission',async()=>{
 const created=await mergeDental([],{dental_revision:0,tooth_details:[{tooth_number:55,surfaces:'pim'}]},{...options,revision:0});
 assert.equal(created.details[0].tooth_number,'55');assert.equal(created.details[0].surfaces,'MOL');
 const cleared=await mergeDental(previous,{dental_revision:3,tooth_details:[{tooth_number:'55',surfaces:null}]},options);
 assert.equal(cleared.details[0].surfaces,null);assert.equal(cleared.details[0].sources.length,1);
 await assert.rejects(()=>mergeDental(previous,{teeth:['16'],tooth_details:[{tooth_number:'55'}]},options),/no coinciden/);
});
test('solo-teeth origin with null finding ID deduplicates by stable non-null key',async()=>{
 const result=await mergeDental(previous,{dental_revision:3,tooth_details:[{tooth_number:'55',sources:[{id_chart:'chart',finding_id:null,revision:2},{id_chart:'chart',revision:2}]}]},options);
 assert.equal(result.changed,false);assert.equal(result.details[0].sources.length,1);
 assert.match(source.source_key,/^[a-f0-9]{64}$/);
 await assert.rejects(()=>mergeDental(previous,{dental_revision:3,tooth_details:[{tooth_number:'55',sources:[{id_chart:'chart',revision:3}]}]},options),/revisión de origen/);
});
test('new source uses server context and requires odontogram permission',async()=>{
 const body={dental_revision:0,tooth_details:[{tooth_number:'16',sources:[{id_chart:'other-chart',finding_id:'finding',revision:1,context:{label:'Forged'}}]}]};
 await assert.rejects(()=>mergeDental([],body,{...options,revision:0,canReadOdontogram:false}),e=>e.status===403);
 const result=await mergeDental([],body,{...options,revision:0});
 assert.equal(result.details[0].sources[0].context.label,'Server label');assert.equal(result.details[0].manual,false);
});
test('explicit origin removal retains manual selection, another origin and chosen surfaces',async()=>{
 const second={...source,id_chart:'other',source_key:sourceKey('other',null,'55')};
 const old=[{...previous[0],sources:[source,second]}];
 const result=await mergeDental(old,{dental_revision:3,tooth_details:[{tooth_number:'55',remove_sources:[source.source_key]}]},options);
 assert.equal(result.details[0].manual,true);assert.equal(result.details[0].surfaces,'MO');assert.equal(result.details[0].sources[0].id_chart,'other');
 await assert.rejects(()=>mergeDental(old,{dental_revision:3,teeth:[]},{...options,canReadOdontogram:false}),e=>e.status===403);
});
test('saved missing/restricted source never blocks authorized ordinary edits',async()=>{
 const result=await mergeDental(previous,{dental_revision:3,tooth_details:[{tooth_number:'55',surfaces:'D'}]},
  {...options,canReadOdontogram:false,resolveSource:()=>{throw Error('Source unavailable');}});
 assert.equal(result.details[0].surfaces,'D');assert.equal(result.details[0].sources[0].source_key,source.source_key);
 await assert.rejects(()=>mergeDental(previous,{dental_revision:2,tooth_details:[{tooth_number:'55',surfaces:'D'}]},options),e=>e.code==='CO26_PLAN_REVISION');
});
test('document projection ignores internal sources and keeps legacy hash shape without faces',()=>{
 assert.deepEqual(contentProjection({teeth:['55']}),{});
 assert.deepEqual(contentProjection({tooth_details:[{tooth_number:'55',surfaces:null,sources:[source]}]}),{});
 assert.deepEqual(contentProjection({tooth_details:[{tooth_number:'55',surfaces:'om',sources:[source]}]}),{toothDetails:[{tooth_number:'55',surfaces:'MO'}]});
});
test('withdrawal and revision replacement recompute only their contribution, preserving manual and other sources',async()=>{
 const one={...source,finding_id:'first',source_key:sourceKey('chart','first','55'),context:{surfaces:'MO'}},two={...source,id_chart:'second',source_key:sourceKey('second',null,'55'),context:{surfaces:'OL'}};
 const old=[{tooth_number:'55',manual:true,manual_surfaces:'D',surfaces:'MODL',sources:[one,two]}];
 const removed=await mergeDental(old,{dental_revision:3,tooth_details:[{tooth_number:'55',remove_sources:[one.source_key]}]},options);
 assert.equal(removed.details[0].surfaces,'ODL');assert.equal(removed.details[0].manual_surfaces,'D');
 const updated=await mergeDental(old,{dental_revision:3,tooth_details:[{tooth_number:'55',sources:[{...one,revision:4,replace_revision:2}]}]},{...options,resolveSource:async()=>({context:{surfaces:'V'}})});
 assert.equal(updated.details[0].surfaces,'ODVL');assert.equal(updated.details[0].sources.find(item=>item.source_key===one.source_key).revision,4);
 await assert.rejects(()=>mergeDental(old,{dental_revision:3,tooth_details:[{tooth_number:'55',sources:[{...one,revision:4,replace_revision:1}]}]},options),e=>e.status===409);
 const restricted=await mergeDental(old,{dental_revision:3,tooth_details:[{tooth_number:'55',manual_surfaces:null,sources_redacted:true}]},{...options,canReadOdontogram:false});
 assert.equal(restricted.details[0].surfaces,'MOL');assert.equal(restricted.details[0].sources.length,2);
});

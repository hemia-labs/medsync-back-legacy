'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const mysql=require('mysql2/promise'),{Sequelize}=require('sequelize');
test('isolated legacy DAOs: minimal/normal create, idempotency, administrative/clinical update and rollback',{skip:process.env.NC1_ISOLATED_QA!=='1'},async(t)=>{
 const database='nc1_qa_flows_'+Date.now();
 const connection=await mysql.createConnection({host:'127.0.0.1',port:33381,user:'root',password:'nc1-synthetic-only'});
 let db;
 try {
  await connection.query('CREATE DATABASE '+database+' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');await connection.changeUser({database});
  await connection.query('SET FOREIGN_KEY_CHECKS=0');
  for(const table of ['person','address','query','allergy','pathological_personal']) {
   const source=require('./fixtures/nc1-schema.json')[table];
   // Only CREATE structure from the versioned export, never Data or DROP statements.
   await connection.query(source.slice(source.indexOf('CREATE TABLE')));
  }
  await connection.query('CREATE TABLE doctor_professional_profile(id_business VARCHAR(50),id_doctor_professional_profile VARCHAR(50)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await require('../migrations/nc1-identity').apply(connection,{isolated:true});
  const [cols]=await connection.query('SHOW COLUMNS FROM allergy');
  for(const [name,type] of [['review_status',"VARCHAR(30) DEFAULT 'UNREVIEWED'"],['revision','INT DEFAULT 0'],['reviewed_at','DATETIME NULL'],['reviewed_by','VARCHAR(50) NULL']])if(!cols.some(c=>c.Field===name))await connection.query('ALTER TABLE allergy ADD COLUMN '+name+' '+type);
  await connection.query('CREATE TABLE business(id_business VARCHAR(50) PRIMARY KEY)');await connection.query("INSERT INTO business VALUES ('tenant')");
  await connection.query('CREATE TABLE patient_code_counter(singleton INT PRIMARY KEY,next_value INT)');await connection.query('INSERT INTO patient_code_counter VALUES (1,1)');
  await connection.query("CREATE FUNCTION fn_replace_character(v TEXT,a VARCHAR(5),b VARCHAR(5)) RETURNS TEXT DETERMINISTIC RETURN REPLACE(v,a,b)");
  await connection.query("CREATE FUNCTION fn_FormatDate(v TEXT) RETURNS DATE DETERMINISTIC RETURN STR_TO_DATE(v,'%d/%m/%Y')");
  await connection.end();
  db=new Sequelize(database,'root','nc1-synthetic-only',{host:'127.0.0.1',port:33381,dialect:'mysql',logging:false,pool:{max:1,min:0},hooks:{afterConnect:async c=>{await new Promise((resolve,reject)=>c.query('SET FOREIGN_KEY_CHECKS=0',e=>e?reject(e):resolve()));}}});
  const stub=(name,exports)=>{const key=require.resolve(name);require.cache[key]={id:key,filename:key,loaded:true,exports};};
  let uploads=0;
  stub('../../src/db/Sequelize.connection',db);stub('../../src/config/config',{BUCKETS:{FIRMAS:'fixture-only'}});stub('../../src/services/aws/s3',{uploadImage:async()=>{uploads++;return {Location:'synthetic-signature'};}});
  const dao=require('../../src/Dao/mysql/px.dao'),svc=require('../../src/Dao/mysql/identity.dao');
  const body={id_business:'tenant',id_login:'actor',request_id:'synthetic-request-0001',person:{name:'Paciente ficticio',surname:'Ensayo',birthday:'2000-01-01',age:26,telephone:'5555555555',local_telephone:null,ocupation:'Prueba',rfc:null,id_signature:null},address:{place_birth:null,residence:null,direction:null,cp:null},identity:{biologicalSex:'2'}};
  const made=await dao.pxCreateMinimal(body);assert.equal(made.status,200,JSON.stringify(made));const id=made.data.id_person;
  assert.equal((await svc.read('patient',id,'tenant')).data.biologicalSex,'2');
  assert.equal((await dao.pxCreateMinimal(body)).data.code,'PATIENT_CREATE_ALREADY_RECORDED');
  assert.equal((await dao.pxCreateMinimal({...body,identity:{biologicalSex:'3'}})).data.code,'PATIENT_CREATE_PAYLOAD_CONFLICT');
  const [addresses]=await db.query('SELECT * FROM address WHERE id_person=:id',{replacements:{id}});const [queries]=await db.query('SELECT * FROM query WHERE id_person=:id',{replacements:{id}});
  const edit={...body,person:{...body.person,id_person:id},address:addresses[0],identity:{migrantStatus:'returned'},expectedRevision:1};
  assert.equal((await dao.updateAdministrative(edit)).status,200);
  const clinical={...edit,query:queries[0],identity:{genderIdentity:'2'},expectedRevision:2,pathological_data:[]};
  assert.equal((await dao.pxUpdate(clinical)).status,200);
  const wrong={...clinical,expectedRevision:3,address:{...clinical.address,id_address:'other-patient-address'}};
  assert.equal((await dao.pxUpdate(wrong)).status,409);assert.equal((await svc.read('patient',id,'tenant')).revision,3);
  const normal={...body,request_id:undefined,person:{...body.person,name:'Otra ficticia'},query:{reason_consultation:'QA',current_condition:'QA'},allergy:{review_status:'UNREVIEWED',has_allergy:null},files:{},pathological_data:[]};
  const saved=await dao.pxSave(normal);assert.equal(saved.status,200,JSON.stringify(saved));assert.equal((await svc.read('patient',saved.data.id_person,'tenant')).data.biologicalSex,'2');
  const invalid=await dao.pxCreateMinimal({...body,request_id:'synthetic-request-0002',person:{...body.person,name:'Rollback ficticia'},identity:{}});assert.equal(invalid.status,400);const [count]=await db.query("SELECT COUNT(*) AS n FROM person WHERE name='Rollback ficticia'");assert.equal(count[0].n,0);

  const current=async(table)=> (await db.query(`SELECT * FROM ${table} WHERE id_person=:id AND last=1`,{replacements:{id}}))[0][0];
  await t.test('NC1-R1/R2/R3/R7: frontend dates, preserved history, normalized phones and rollback',async()=>{
   const revision=(await svc.read('patient',id,'tenant')).revision;
   const clinical2={...clinical,identity:undefined,expectedRevision:revision,person:{...clinical.person,birthday:'01-01-2000',telephone:'(55) 1234-5678',local_telephone:'(55) 9876-5432'},address:{...await current('address'),direction:'Domicilio nuevo'},query:{...await current('query'),reason_consultation:'Motivo nuevo'}};
   const result=await dao.pxUpdate(clinical2);assert.equal(result.status,200,JSON.stringify(result));
   assert.equal((await svc.read('patient',id,'tenant')).revision,revision,'same civil date does not spuriously write identity');
   for(const table of ['address','query']){const [rows]=await db.query(`SELECT * FROM ${table} WHERE id_person=:id`,{replacements:{id}});assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.last===1).length,1);assert.equal(rows.filter(r=>r.last===0).length,2);}
   const [people]=await db.query("SELECT telephone,local_telephone,DATE_FORMAT(birthday,'%Y-%m-%d') birthday FROM person WHERE id_person=:id",{replacements:{id}});
   assert.deepEqual(people[0],{telephone:'5512345678',local_telephone:'5598765432',birthday:'2000-01-01'});
   const snapshot=async()=>JSON.stringify((await db.query('SELECT * FROM address WHERE id_person=:id ORDER BY id_address',{replacements:{id}}))[0]);
   const before=await snapshot();
   assert.equal((await dao.pxUpdate({...clinical2,address:{...await current('address'),direction:'Must rollback'},query:{...await current('query'),id_query:'wrong-child'}})).status,409);assert.equal(await snapshot(),before);
   assert.equal((await dao.pxUpdate({...clinical2,person:{...clinical2.person,birthday:'31-02-2000'}})).status,400);
   const [oldQuery]=await db.query('SELECT reason_consultation FROM query WHERE id_query=:qid',{replacements:{qid:queries[0].id_query}});assert.notEqual(oldQuery[0].reason_consultation,'Motivo nuevo');
  });
  await t.test('NC1-R4: foreign tenant cannot upload a signature',async()=>{
   assert.equal((await dao.pxUpdate({...clinical,id_business:'foreign',files:{file:'synthetic'},person:{...clinical.person,id_signature:null}})).status,404);assert.equal(uploads,0);
  });
  await t.test('NC1-R9: historical JSON keeps its legacy shape without row identifier',async()=>{
   await db.query("INSERT INTO pathological_personal (id_pathological_personal,id_person,id_business,id_type_pathological_personal,json,created_by) VALUES ('qa-path',:id,'tenant','qa-type','{}','actor')",{replacements:{id}});
   const result=await dao.pxUpdate({...clinical,identity:undefined,expectedRevision:3,address:await current('address'),query:await current('query'),pathological_data:[{id_pathological_personal:'qa-path',id_type_pathological_personal:'qa-type',answer:'synthetic'}]});
   assert.equal(result.status,200,JSON.stringify(result));
   const [[row]]=await db.query("SELECT json FROM pathological_personal WHERE id_pathological_personal='qa-path'");
   const json=typeof row.json==='string'?JSON.parse(row.json):row.json;
   assert.equal(json.id_pathological_personal,undefined);assert.equal(json.answer,'synthetic');
  });
  await t.test('NC1-R5/R7: normal create supports both day-first formats and ISO with real date fixture',async()=>{
   const [[fn]]=await db.query("SELECT DATE_FORMAT(fn_FormatDate('31/01/2000'),'%Y-%m-%d') value");assert.equal(fn.value,'2000-01-31');
   for(const birthday of ['31-01-2000','31/01/2000','2000-01-31']){
    const result=await dao.pxSave({...normal,person:{...normal.person,name:'Fixture '+birthday,birthday}});assert.equal(result.status,200,JSON.stringify(result));assert.equal((await svc.read('patient',result.data.id_person,'tenant')).data.birthDate,'2000-01-31');
   }
   assert.equal((await dao.pxSave({...normal,person:{...normal.person,birthday:'01/31/2000'}})).status,400);
  });
 }finally{if(db)await db.close();try{await connection.end();}catch(_){} }
});

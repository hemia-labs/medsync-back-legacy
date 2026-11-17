'use strict';
// Deliberately fixed to a disposable localhost QA database. Never reads .env or production config.
const test=require('node:test');const assert=require('node:assert/strict');
const mysql=require('mysql2/promise');const {Sequelize}=require('sequelize');
const {apply}=require('../migrations/nc1-identity');const {createService}=require('../../src/domain/identity/service');
const enabled=process.env.NC1_ISOLATED_QA==='1';
test('isolated MySQL: additive/reentrant DDL, tenant, PATCH, rollback, concurrency, candidates and roles',{skip:!enabled},async()=>{
 const database='nc1_qa_identity_'+Date.now();
 const connection=await mysql.createConnection({host:'127.0.0.1',port:33381,user:'root',password:'nc1-synthetic-only'});
 await connection.query('CREATE DATABASE '+database+' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');await connection.changeUser({database});
 const db=new Sequelize(database,'root','nc1-synthetic-only',{host:'127.0.0.1',port:33381,dialect:'mysql',logging:false,pool:{max:1,min:0},timezone:'+00:00'});
 try {
  await connection.query('CREATE TABLE IF NOT EXISTS business(id_business VARCHAR(50) PRIMARY KEY)');
  await connection.query('CREATE TABLE IF NOT EXISTS person(id_person VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),name VARCHAR(500),surname VARCHAR(500),birthday DATE,age INT,updated_at DATETIME,updated_by VARCHAR(50))');
  await connection.query('CREATE TABLE IF NOT EXISTS doctor_professional_profile(id_doctor_professional_profile VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),id_login VARCHAR(50),professional_name VARCHAR(250),updated_at DATETIME,updated_by VARCHAR(50))');
  await apply(connection,{isolated:true});await apply(connection,{isolated:true});
  await assert.rejects(()=>apply(connection),/Solo QA/);
  const stamp=Date.now().toString(),biz='qa-'+stamp,patient='p-'+stamp,profile='d-'+stamp;
  await connection.execute('INSERT INTO business VALUES (?)',[biz]);
  await connection.execute('INSERT INTO person(id_person,id_business,name,surname,birthday) VALUES (?,?,?,?,?)',[patient,biz,'Ficticia','De la Prueba Ensayo','2000-01-01']);
  await connection.execute('INSERT INTO doctor_professional_profile(id_doctor_professional_profile,id_business,id_login,professional_name) VALUES (?,?,?,?)',[profile,biz,'actor','Profesional Ficticio']);
  const svc=createService(db);const old=await svc.read('patient',patient,biz);assert.equal(old.revision,0);assert.equal(old.data.firstSurname,null);
  await assert.rejects(()=>svc.read('patient',patient,'other'),e=>e.status===404);
  const first=await svc.save('patient',patient,biz,'actor',{biologicalSex:'2',migrantStatus:'returned',birthCountry:{family:'sis.country',code:'142'},affiliations:[{family:'sis.affiliation',code:'0'}]},0);
  assert.equal(first.revision,1);assert.equal(first.catalogValidation,'unverified');
  const saved=await svc.read('patient',patient,biz);assert.equal(saved.data.legacySurname,'De la Prueba Ensayo');assert.equal(saved.data.birthCountry.code,'142');assert.equal(saved.data.affiliations[0].code,'0');
  await assert.rejects(()=>svc.save('patient',patient,biz,'actor',{biologicalSex:'1'},0),e=>e.status===409);
  await svc.save('patient',patient,biz,'actor',{migrantStatus:null},1);assert.equal((await svc.read('patient',patient,biz)).data.biologicalSex,'2');
  const raced=await Promise.allSettled([svc.save('patient',patient,biz,'actor',{genderIdentity:'1'},2),svc.save('patient',patient,biz,'actor',{genderIdentity:'2'},2)]);assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);assert.equal(raced.find(x=>x.status==='rejected').reason.status,409);
  await assert.rejects(()=>db.transaction(async t=>{await svc.patientWrite({id_business:biz,id_login:'actor',person:{name:'Ficticia',surname:'De la Prueba Ensayo',birthday:'2000-01-01'},identity:{biologicalSex:'3'},expectedRevision:3},patient,t);throw new Error('rollback fixture');}),/rollback fixture/);
  assert.equal((await svc.read('patient',patient,biz)).revision,3);
  await assert.rejects(()=>svc.save('professional',profile,biz,'actor',{authorizedPersonnelTypes:[{family:'sis.personnel_type',code:'13'}]},0),e=>e.status===403);
  await svc.save('professional',profile,biz,'actor',{authorizedPersonnelTypes:[{family:'sis.personnel_type',code:'13'}]},0,true);
  const e=await svc.save('establishment',null,biz,'actor',{displayName:'Unidad ficticia QA',cluesRef:{family:'sis.establishments',code:'ASSSA000013'}},0);
  assert.equal((await svc.read('establishment',e.id,biz)).data.cluesRef.releaseId,undefined);
  await assert.rejects(()=>connection.execute('UPDATE care_establishment SET clues_family=NULL,clues_release_id=? WHERE id_care_establishment=?',['fake-release',e.id]));
  // Real router/service/SQL, simulated authorization and CSRF boundary only; never starts the product app.
  const stub=(name,exports)=>{const key=require.resolve(name);require.cache[key]={id:key,filename:key,loaded:true,exports};};
  stub('../../src/db/Sequelize.connection',db);
  stub('../../src/auth/authenticate',{Auth:(req,res,next)=>{if(!req.headers['x-qa-actor'])return res.sendStatus(401);req.tokenDecode={id_login:req.headers['x-qa-actor'],id_business:biz};next();}});
  stub('../../src/middleware/requireTenantOperational.middleware',(_req,_res,next)=>next());
  stub('../../src/middleware/requirePermission.middleware',{requirePermission:()=> (req,res,next)=>req.tokenDecode.id_login==='actor'?next():res.sendStatus(403)});
  stub('../../src/util/effectivePermissions',{hasPermission:async actor=>actor==='actor'});
  stub('../../src/middleware/csrf.middleware',{csrfProtection:()=> (req,res,next)=>req.headers['x-qa-csrf']==='test'?next():res.sendStatus(403)});
  const express=require('express'),app=express();app.use(express.json());app.use('/api/identity',require('../../src/routes/mysql/identity'));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/api/identity';
  try {
   assert.equal((await fetch(url+'/patients/'+patient)).status,401);
   const headers={'content-type':'application/json','x-qa-actor':'actor','x-qa-csrf':'test'};
   assert.equal((await fetch(url+'/patients/'+patient,{headers})).status,200);
   assert.equal((await fetch(url+'/patients/'+patient,{method:'PATCH',headers:{...headers,'x-qa-csrf':''},body:JSON.stringify({identity:{biologicalSex:'1'},expectedRevision:3})})).status,403);
   assert.equal((await fetch(url+'/patients/'+patient,{method:'PATCH',headers,body:JSON.stringify({identity:{biologicalSex:'1'},expectedRevision:0})})).status,409);
   assert.equal((await fetch(url+'/patients/'+patient,{method:'PATCH',headers,body:JSON.stringify({identity:{biologicalSex:'1'},expectedRevision:3,id_business:'other'})})).status,400);
   // Query/body 'id' cannot trick the self guard into reading another professional.
   assert.equal((await fetch(url+'/professionals/actor?id=unprivileged',{headers:{...headers,'x-qa-actor':'unprivileged'}})).status,403);
   assert.equal((await fetch(url+'/professionals/actor',{headers})).status,200);
  } finally {await new Promise(resolve=>server.close(resolve));}
  const [fks]=await connection.query("SELECT REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME LIKE 'sis_catalog%'");assert.equal(fks.length,0);
  await connection.query('ALTER TABLE care_establishment ADD COLUMN unexpected_column INT');await assert.rejects(()=>apply(connection,{isolated:true}),/Deriva de estructura/);
 } finally {await db.close();await connection.end();}
});

// Run against an isolated local MySQL with NC5_QA_MYSQL_PORT.
// Creates a randomly named schema with synthetic rows and removes only that schema.
'use strict';
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {Sequelize}=require('sequelize');
const port=Number(process.env.NC5_QA_MYSQL_PORT);
if(!Number.isInteger(port) || port<=0 || port>65535) throw Error('Indica el puerto de MySQL aislado.');
const schema='nc5_draft_qa_'+randomBytes(8).toString('hex');
const opts={host:'127.0.0.1',port,dialect:'mysql',logging:false};
const admin=new Sequelize('mysql','root','',opts);
const db=new Sequelize(schema,'root','',opts);
const definitions=[
 'doctor_professional_profile (id_login VARCHAR(50),id_business VARCHAR(50),id_doctor_professional_profile VARCHAR(50),professional_name VARCHAR(255),professional_license VARCHAR(100),is_active INT)',
 'person (id_person VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),active INT)',
 'login (id_login VARCHAR(50),id_business VARCHAR(50),id_rol VARCHAR(50),email VARCHAR(80),locked INT,active INT)',
 'rol (id_rol VARCHAR(50),code VARCHAR(50),desc_rol VARCHAR(50),active INT)',
 'business (id_business VARCHAR(50),active INT,status VARCHAR(30),billing_revision INT,billing_access_until DATETIME,subscription_status VARCHAR(30),trial_starts_at DATETIME,trial_ends_at DATETIME,current_period_starts_at DATETIME,current_period_ends_at DATETIME,suspended_at DATETIME,cancelled_at DATETIME,status_reason VARCHAR(50))',
 'session (id_session VARCHAR(50),id_login VARCHAR(50),active INT,`last` INT)',
 'cat_permission (id_cat_permission INT,code VARCHAR(50),active INT,is_active INT)',
 'permission_rol (id_rol VARCHAR(50),id_cat_permission INT,active INT)',
 'business_role_permission (id_business VARCHAR(50),id_rol VARCHAR(50),id_cat_permission INT,active INT)',
 'appointment (id_appointment VARCHAR(50),id_person VARCHAR(50),id_business VARCHAR(50),active INT)',
 'treatment_plan (id_treatment_plan VARCHAR(50),id_person VARCHAR(50),id_business VARCHAR(50),active INT,status VARCHAR(50))',
 'patient_treatment (id_patient_treatment VARCHAR(50),id_treatment_plan VARCHAR(50),id_person VARCHAR(50),id_business VARCHAR(50),active INT,status VARCHAR(50),name VARCHAR(255),cost DECIMAL(10,2),source VARCHAR(50),created_by VARCHAR(50),created_at DATETIME)'
];
async function run(){
 await admin.query('CREATE DATABASE '+schema+' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
 let server;
 try {
  for(const spec of definitions)await db.query('CREATE TABLE '+spec);
  await db.query(fs.readFileSync(path.join(__dirname,'../migrations/nc5-evolution-draft.sql'),'utf8'));
  for(const file of ['nc5-evolution-signed.sql','nc5-performed-extra.sql'])
    await db.query(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
  await db.query('CREATE TABLE patient_code_counter(singleton INT PRIMARY KEY,next_value INT)');
  await db.query('INSERT INTO patient_code_counter VALUES (1,1)');
  await db.query('ALTER TABLE person ADD code VARCHAR(8), ADD UNIQUE INDEX uq_code(code)');
  const readiness=require('../../src/services/readiness').createReadiness(db);
  for(const table of ['evolution_note_draft','evolution_note_signed_version','evolution_note_performed_extra']){
    await db.query('RENAME TABLE '+table+' TO qa_held_table');
    await assert.rejects(readiness.initialize(),/NC5_NOTES_MIGRATION_REQUIRED/);
    assert.equal(await readiness.check(),false);
    await db.query('RENAME TABLE qa_held_table TO '+table);
  }
  await readiness.initialize();assert.equal(await readiness.check(),true);
  console.log('PASS readiness NC5: cada tabla ausente bloquea; esquema completo listo.');
  for(const sql of [
   "INSERT INTO doctor_professional_profile VALUES ('doctor','clinic','profile','Doctora de prueba','TEST01',1)",
   "INSERT INTO person (id_person,id_business,active) VALUES ('p','clinic',1),('outside','other',1)",
   "INSERT INTO business (id_business,active,status,subscription_status) VALUES ('clinic',1,'active','active')",
   "INSERT INTO login VALUES ('doctor','clinic','r','doctor@example.invalid',0,1),('agenda','clinic','a','agenda@example.invalid',0,1),('colleague','clinic','r','colleague@example.invalid',0,1)",
   "INSERT INTO rol VALUES ('r','doctor','Doctor',1),('a','assistant','Assistant',1)",
   "INSERT INTO session VALUES ('one','doctor',1,1),('two','doctor',1,1),('three','agenda',1,1),('four','colleague',1,1)",
   "INSERT INTO cat_permission VALUES (1,'px.tab.monitoring',1,1),(2,'tracing.create',1,1),(3,'tracing.correct',1,1)",
   "INSERT INTO permission_rol VALUES ('r',1,1),('r',2,1),('r',3,1)",
   "INSERT INTO appointment VALUES ('visit','p','clinic',1),('foreign','outside','other',1)",
   "INSERT INTO treatment_plan VALUES ('plan','p','clinic',1,'active')",
   "INSERT INTO patient_treatment (id_patient_treatment,id_treatment_plan,id_person,id_business,active,status,name) VALUES ('t','plan','p','clinic',1,'pending','Ajuste'),('future','plan','p','clinic',1,'pending','Próximo'),('later','plan','p','clinic',1,'pending','Adicional del plan')"
  ])await db.query(sql);
  await db.query("ALTER TABLE cat_permission ADD value INT, ADD sec INT");
  await db.query("INSERT INTO cat_permission (id_cat_permission,code,active,is_active) VALUES (4,'px.dates',1,1)");
  await db.query("INSERT INTO permission_rol VALUES ('a',4,1)");
  await db.query("ALTER TABLE login ADD name VARCHAR(80)");
  await db.query("ALTER TABLE person ADD name VARCHAR(80),ADD surname VARCHAR(80)");
  await db.query("UPDATE person SET name='Paciente',surname='Prueba',code='000009' WHERE id_person='p'");
  await db.query("UPDATE login SET name=id_login");
  await db.query("INSERT INTO login (id_login,id_business,id_rol,email,active,locked,name) VALUES ('remote','other','r','remote@example.invalid',1,0,'Remote')");
  await db.query('CREATE TABLE tracing (id_tracing VARCHAR(50) PRIMARY KEY)');
  const migration=require('../migrations/nc5-internal-chat');
  const migrationDb=await require('mysql2/promise').createConnection({host:opts.host,port,user:'root',database:schema});
  try {
    assert.equal((await migration.audit(migrationDb)).alreadyApplied,false);
    assert.equal((await migration.apply(migrationDb)).alreadyApplied,true);
    assert.equal((await migration.apply(migrationDb)).alreadyApplied,true);
  } finally { await migrationDb.end(); }
  process.env.JWT_SECRET=randomBytes(48).toString('hex');
  process.env.AUTH_COOKIE_MODE='legacy';process.env.BROWSER_AUTH_TRANSPORT='bearer';process.env.CSRF_ENABLED='false';
  const dep=require.resolve('../../src/db/Sequelize.connection');
  require.cache[dep]={id:dep,filename:dep,loaded:true,exports:db};
  const express=require('express'),app=express();
  app.use(express.json());app.use('/api/tracing',require('../../src/routes/mysql/tracing'));
  app.use('/api/chat',require('../../src/routes/mysql/chat'));
  app.use((err,req,res,next)=>{console.error(err.message);res.sendStatus(500)});
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
  const issue=(login,session)=>require('../../src/auth/authenticate').GetAccessToken({id_business:'clinic',id_login:login,id_session:session}).token;
  const A=issue('doctor','one'),B=issue('doctor','two'),C=issue('colleague','four'),D=issue('agenda','three');
  const call=async(token,body=null,id='',patient='p')=>{
    const url='http://127.0.0.1:'+server.address().port+'/api/tracing/patient/'+patient+'/evolution-drafts'+(id?'/'+id:'');
    const result=await fetch(url,{method:body?'PUT':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:result.status,...await result.json()};
  };
  await db.query('ALTER TABLE treatment_plan ADD title VARCHAR(255),ADD started_at DATE,ADD closed_at DATETIME');
  const id=randomUUID(),form={date:'2026-11-20',origin:'visit',reason:'Control',done:[{id:'t',name:'ignored'}],future:[{id:'future'}],performed:'Adicional'};
  const draft={revision:0,form};const saved=await call(A,draft,id);
  assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(saved.data.form.done[0].name,'Ajuste');
  assert.equal((await call(A,draft,id)).data.revision,1);
  assert.equal((await call(B)).data.items[0].id,id);
  assert.equal((await call(C)).data.items.length,0);assert.equal((await call(D)).status,403);
  assert.equal((await call(A,null,'','outside')).status,404);
  assert.equal((await call(A,{revision:0,form:{...form,origin:'foreign'}},randomUUID())).status,400);
  assert.equal((await call(A,{revision:0,form:{...form,origin:'',future:[{id:'unknown'}]}},randomUUID())).status,400);
  assert.equal((await call(B,draft,randomUUID())).status,409);
  const readReview=async revision=>{
    const url='http://127.0.0.1:'+server.address().port+'/api/tracing/patient/p/evolution-drafts/'+id+'/review?revision='+revision;
    return fetch(url,{headers:{authorization:'Bearer '+B}});
  };
  assert.equal((await readReview(1)).status,400);
  const edits=await Promise.all([A,B].map((token,i)=>call(token,{revision:1,form:{...form,evolution:'Sesión '+i}},id)));
  assert.deepEqual(edits.map(e=>e.status).sort(),[200,409]);const current=edits.find(e=>e.status===409).data;
  assert.equal(current.revision,2);assert.equal((await call(B,{revision:2,form:{...current.form,plan:'Reconciliado'}},id)).data.revision,3);
  assert.equal((await readReview(1)).status,409);
  assert.equal((await readReview(3)).status,200);
  const visit=await fetch('http://127.0.0.1:'+server.address().port+'/api/tracing/patient/p/evolution-drafts?origin=visit',{headers:{authorization:'Bearer '+A}});
  assert.equal((await visit.json()).data.items[0].id,id);
  for(let i=0;i<10;i++)assert.equal((await call(A,{revision:0,form:{done:[],future:[]}},randomUUID())).status,200);
  const listed=await call(A);assert.equal(listed.data.items.length,10);assert.equal(listed.data.pagination.total,11);
  const signed=async(token,suffix='',body,patient='p')=>{
    const url='http://127.0.0.1:'+server.address().port+'/api/tracing/patient/'+patient+'/evolution-notes'+suffix;
    const r=await fetch(url,{method:body?'PUT':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body&&JSON.stringify(body)});
    return {status:r.status,...await r.json()};
  };
  const submit={revision:3,requestId:randomUUID()},sign='/'+id+'/sign',correct='/'+id+'/rectify';
  assert.equal((await signed(D,sign,submit)).status,403);
  assert.equal((await signed(A,sign,{...submit,revision:1})).status,409);
  await db.query('UPDATE doctor_professional_profile SET is_active=0');
  assert.equal((await signed(A,sign,submit)).status,403);
  await db.query('UPDATE doctor_professional_profile SET is_active=1');
  await db.query('ALTER TABLE patient_treatment ADD updated_by VARCHAR(50),ADD updated_at DATETIME');
  assert.equal((await signed(A,sign,submit)).status,403);
  await db.query("INSERT INTO cat_permission (id_cat_permission,code,active,is_active) VALUES (5,'treatments.complete',1,1)");
  await db.query("INSERT INTO permission_rol VALUES ('r',5,1)");
  const statuses=async()=>Object.fromEntries((await db.query("SELECT id_patient_treatment,status FROM patient_treatment"))[0].map(r=>[r.id_patient_treatment,r.status]));
  assert.equal((await statuses()).t,'pending');
  const closes=await Promise.all([A,B].map(t=>signed(t,sign,submit)));
  for(const result of closes)assert.equal(result.data?.version,1,JSON.stringify(result));
  assert.equal((await call(A,{revision:3,form},id)).status,400);
  assert.equal((await call(A)).data.pagination.total,10);
  const linked=await fetch('http://127.0.0.1:'+server.address().port+'/api/tracing/patient/p/evolution-drafts?origin=visit',{headers:{authorization:'Bearer '+A}});
  assert.equal((await linked.json()).data.signedId,id);
  assert.equal((await call(A,draft,randomUUID())).status,400);
  assert.equal((await statuses()).t,'completed');assert.equal((await statuses()).future,'pending');
  const orig=closes[0].data.form;
  const update={revision:1,requestId:randomUUID(),reason:'Precisión de intervalo',form:{...orig,done:[...orig.done,{id:'later'}],plan:'En tres semanas'}};
  assert.equal((await signed(C,correct,update)).status,403);
  assert.equal((await signed(A,correct,{...update,reason:''})).status,400);
  assert.equal((await signed(A,correct,{...update,form:orig})).status,400);
  const competing=[update,{...update,requestId:randomUUID(),form:{...update.form,plan:'En dos semanas'}}];
  const results=await Promise.all(competing.map(u=>signed(A,correct,u)));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const winner=competing[results.findIndex(r=>r.status===200)];
  assert.equal((await signed(B,correct,winner)).data.version,2);
  assert.equal((await statuses()).later,'completed');assert.equal((await statuses()).future,'pending');
  const versions=await signed(C,'/'+id+'/versions');
  assert.deepEqual(versions.data.items.map(r=>r.version),[2,1]);
  assert.deepEqual(versions.data.items[1].form,orig);
  assert.equal(versions.data.items[0].reason,update.reason);
  assert.equal((await signed(C)).data.pagination.total,1);
  assert.equal((await signed(D)).status,403);
  assert.equal((await signed(A,'/'+id+'/versions',undefined,'outside')).status,404);
  const chat=async(token,route,body)=>{
    const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/chat/'+route,{
      method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:body?JSON.stringify(body):undefined});
    return res.json();
  };
  const context={kind:'evolution_note',patientId:'p',noteId:id};
  const notice={context,reason:'control',recipientId:'agenda',clientRequestId:randomUUID()};
  const noticePath='notices/context/evolution_note/'+id;
  assert.equal((await chat(A,'notices',{...notice,recipientId:'remote'})).status,422);
  assert.equal((await chat(D,'notices',{...notice,recipientId:'doctor'})).status,403);
  assert.equal((await chat(D,noticePath)).status,403);
  const retry=await Promise.all([A,B].map(t=>chat(t,'notices',notice)));
  for(const item of retry)assert.equal(item.status,200,JSON.stringify(item));
  assert.equal(retry[0].data.messageId,retry[1].data.messageId);
  assert.equal((await chat(A,'notices',{...notice,reason:'otro'})).status,409);
  assert.equal((await chat(A,noticePath)).data.items[0].readAt,null);
  const incoming=await chat(D,'conversations/doctor/messages');
  assert.equal(incoming.data.items[0].notice.patient.restricted,false);
  assert.equal(incoming.data.items[0].notice.canCoordinate,true);
  assert.equal(incoming.data.items[0].notice.professional,'Doctora de prueba');
  await chat(D,'conversations/doctor/read',{upToId:incoming.data.items[0].id});
  const receipt=await chat(A,noticePath);
  assert.equal(receipt.data.items.length,1);assert.ok(receipt.data.items[0].readAt);
  assert.equal((await signed(A,'/'+id+'/versions')).data.items.length,2);
  console.log('PASS nota formal -> aviso -> reintento -> lectura, sin otra firma.');
  const [extras]=await db.query("SELECT * FROM patient_treatment WHERE source='performed_extra'");
  assert.equal(extras.length,1);
  const options=async(mode='latest')=>(await call(A,null,'procedure-options?history='+mode)).data;
  const active=await options();
  assert.equal(active.active,true);
  const historical=randomUUID(), testForm={...orig,origin:'',performed:'',done:[{id:'future'}],future:[]};
  assert.equal((await call(A,{revision:0,form:testForm},historical)).status,200);
  await db.query("UPDATE treatment_plan SET status='closed',title='Más reciente',closed_at='2026-11-19' WHERE id_treatment_plan='plan'");
  await db.query("INSERT INTO treatment_plan (id_treatment_plan,id_person,id_business,active,status,title,closed_at) VALUES ('older','p','clinic',1,'closed','Anterior','2026-10-01')");
  await db.query("INSERT INTO patient_treatment (id_patient_treatment,id_treatment_plan,id_person,id_business,active,status,name) VALUES ('olditem','older','p','clinic',1,'completed','Ajuste')");
  assert.deepEqual((await options()).plans.map(p=>p.id),['plan']);
  assert.deepEqual((await options('all')).plans.map(p=>p.id),['plan','older']);
  assert.equal((await call(A,{revision:0,form:{...testForm,done:[],future:[{id:'olditem'}]}},randomUUID())).status,400);
  const completed=randomUUID();
  assert.equal((await call(A,{revision:0,form:{...testForm,done:[{id:'olditem'}]}},completed)).status,200);
  const reviewOrigin=await call(A,null,completed+'/review?revision=1');
  assert.equal(reviewOrigin.data.form.done[0].planId,'older');
  assert.equal(reviewOrigin.data.form.done[0].closedDate,'2026-10-01');
  assert.equal((await signed(A,'/'+completed+'/sign',{requestId:randomUUID(),revision:1})).data.form.done[0].closedPlan,true);
  await db.query("INSERT INTO treatment_plan (id_treatment_plan,id_person,id_business,active,status,title) VALUES ('next','p','clinic',1,'active','Nuevo')");
  assert.deepEqual((await options('all')).plans.map(p=>p.id),['next']);
  assert.equal((await call(A,{revision:0,form:testForm},randomUUID())).status,400);
  const edit=await call(A,{revision:1,form:{...testForm,plan:'Seguimiento del plan anterior'}},historical);
  assert.equal(edit.status,200);
  const signing={requestId:randomUUID(),revision:edit.data.revision};
  const historyPath='/'+historical+'/sign';
  const needs=await signed(A,historyPath,signing);
  assert.equal(needs.status,409);
  assert.deepEqual(needs.data.items.map(i=>i.id),['future']);
  assert.equal((await signed(A,historyPath,{...signing,confirmedClosed:['other']})).status,409);
  const accepted={...signing,confirmedClosed:['future']};
  for(let i=0;i<2;i++){
    const result=await signed(A,historyPath,accepted);
    assert.equal(result.data.form.done[0].noteOnly,true);
    assert.equal(result.data.version,1);
  }
  assert.equal((await statuses()).future,'pending');
  console.log('PASS planes: activo, último, todos, previstos, borrador conservado, firma histórica y confirmación sin cambiar plan.');
  console.log('PASS firma y rectificación: atomicidad, reintento, permisos, conflicto, original y tratamiento adicional.');
  console.log('PASS HTTP/MySQL: dos sesiones, borrador parcial, reintento, concurrencia, reconciliación, cita, procedimientos, paginación y permisos.');
 }finally{
  if(server) await new Promise(resolve=>server.close(resolve));
  await db.close();await admin.query('DROP DATABASE '+schema);await admin.close();
 }
}
run().catch(error=>{console.error(error.message);process.exitCode=1});

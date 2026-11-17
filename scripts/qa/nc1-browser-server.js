'use strict';
// Local synthetic fixture. Real auth controller/DAO, JWT, session, CSRF, permission and NC1 routes.
// No .env files: explicit localhost DB and newly-created fixture DB only.
const mysql=require('mysql2/promise'),{Sequelize}=require('sequelize'),crypto=require('node:crypto');
async function main(){
 if(process.env.NC1_ISOLATED_QA!=='1')throw Error('Explicit isolated QA required');
 const database='nc1_qa_browser_'+Date.now();
 Object.assign(process.env,{NODE_ENV:'test',JWT_SECRET:crypto.randomBytes(48).toString('hex'),CSRF_TOKEN_SECRET:crypto.randomBytes(48).toString('hex'),JWT_EXPIRES_IN:'30m',AUTH_COOKIE_MODE:'d2',BROWSER_AUTH_TRANSPORT:'cookie',AUTH_COOKIE_SECURE:'false',AUTH_COOKIE_ACCESS_NAME:'nc1_at',AUTH_COOKIE_REFRESH_NAME:'nc1_rt',AUTH_CSRF_COOKIE_NAME:'nc1_csrf',CSRF_ENABLED:'true',CORS_CREDENTIALS:'true',CORS_ALLOWED_ORIGINS:'http://127.0.0.1:33401',CSRF_ALLOWED_ORIGINS:'http://127.0.0.1:33401',REGISTRATION_IDENTITY_ENABLED:'false',REGISTRATION_ACTIVATION_ENABLED:'false'});
 const stub=(p,exports)=>{const id=require.resolve(p);require.cache[id]={id,filename:id,loaded:true,exports};};
 stub('../../src/config/env',{});
 const conn=await mysql.createConnection({host:'127.0.0.1',port:33381,user:'root',password:'nc1-synthetic-only'});
 await conn.query('CREATE DATABASE '+database+' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');await conn.changeUser({database});
 await conn.query('SET FOREIGN_KEY_CHECKS=0');for(const sql of Object.values(require('./fixtures/nc1-schema.json')))await conn.query(sql);await conn.query('SET FOREIGN_KEY_CHECKS=1');
 await conn.query('ALTER TABLE login ADD first_name VARCHAR(100), ADD last_name VARCHAR(100)');
 await require('../migrations/nc1-identity').apply(conn,{isolated:true});
 await conn.query("INSERT INTO business(id_business,name,slug,subscription_status) VALUES ('qa','Consultorio ficticio','nc1-qa','active'),('foreign','Otro ficticio','other-qa','active')");
 await conn.query("INSERT INTO rol(id_rol,code,desc_rol,active) VALUES ('doctor','doctor','Doctor QA',1)");
 const password=await require('bcryptjs').hash('NC1-Synthetic-Only-2026!',10);
 await conn.execute("INSERT INTO login(id_login,id_business,id_rol,name,email,password,active,locked,first_name,last_name) VALUES ('actor','qa','doctor','Profesional ficticio','nc1@example.invalid',?,1,0,'Ana','Ensayo')",[password]);
 for(const permission of ['px.all','px.new','admin.config','clinical_history.edit_draft']){
  await conn.execute('INSERT INTO cat_permission(id_cat_permission,code,name,description,active,is_active) VALUES (?,?,?,?,1,1)',[permission,permission,permission,permission]);
  await conn.execute("INSERT INTO permission_rol(id_permission_rol,id_cat_permission,id_rol) VALUES (?,?,'doctor')",[permission,permission]);
 }
 await conn.query(`CREATE PROCEDURE SP_login_by_idlogin(IN login_id VARCHAR(50),IN ignored BOOLEAN)
 BEGIN DECLARE sid VARCHAR(50); SET sid=UUID(); UPDATE session SET active=0,last=0 WHERE id_login=login_id;
 INSERT INTO session(id_session,id_login,active,last,created_at) VALUES(sid,login_id,1,1,NOW());
 SELECT l.*,sid AS id_session FROM login l WHERE l.id_login=login_id; END`);
 await conn.query("INSERT INTO person(id_person,id_business,name,surname,birthday,age,telephone,active) VALUES ('patient','qa','Paciente','Ensayo','2000-01-31',26,'5512345678',1),('foreign-patient','foreign','Otro','Ficticio','2000-01-31',26,'5512345678',1)");
 await conn.query("INSERT INTO address(id_address,id_business,id_person,direction,last) VALUES ('address','qa','patient','Domicilio inicial',1)");
 await conn.query("INSERT INTO doctor_professional_profile(id_doctor_professional_profile,id_business,id_login,professional_name,professional_phone,is_active,can_issue_prescriptions) VALUES ('profile','qa','actor','Nombre anterior','5512345678',1,0)");
 const db=new Sequelize(database,'root','nc1-synthetic-only',{host:'127.0.0.1',port:33381,dialect:'mysql',logging:false,pool:{max:1,min:0}});stub('../../src/db/Sequelize.connection',db);
 // External effects are forbidden; authorization/session/CSRF are not mocked.
 stub('../../src/mail/mail',{});stub('../../src/services/aws/privateImages',{remove:async()=>{},signedImage:async()=>null,digest:()=>null,readUrl:async()=>null,upload:()=>{throw Error('No upload in QA');}});
 stub('../../src/util/tracingPermissions',{seedTracingPermissions:async()=>{}});stub('../../src/util/dashboardAccess',{seedDashboardPermissions:async()=>{}});
 const express=require('express'),app=express();app.use(express.json({limit:'1mb'}));app.use(require('cookie-parser')());
 app.use('/api/auth',require('../../src/routes/mysql/auth'));
 app.use('/api/identity',require('../../src/routes/mysql/identity'));
 app.use('/api/px',require('../../src/routes/mysql/px'));
 app.use('/api/user',require('../../src/routes/mysql/user'));
 const Token=require('../../src/auth/authenticate');
 app.get('/qa/patient',Token.Auth,async(req,res)=>{
  const [person]=await db.query("SELECT * FROM person WHERE id_person='patient' AND id_business=:b",{replacements:{b:req.tokenDecode.id_business},type:'SELECT'});
  const [address]=await db.query("SELECT * FROM address WHERE id_person='patient' AND id_business=:b AND last=1",{replacements:{b:req.tokenDecode.id_business},type:'SELECT'});
  const service=require('../../src/Dao/mysql/identity.dao'),r=await service.read('patient','patient',req.tokenDecode.id_business);
  res.send({status:200,data:{person:{...person,birthday:'2000-01-31'},address,identity:service.view(r.data,r.revision)}});
 });
 app.post('/qa/revoke',Token.Auth,async(req,res)=>{await db.query('UPDATE session SET active=0 WHERE id_session=:id',{replacements:{id:req.tokenDecode.id_session}});res.sendStatus(204);});
 const front=process.env.NC1_FRONT_ROOT;if(!front)throw Error('NC1_FRONT_ROOT required');
 app.use('/source',express.static(require('node:path').join(front,'src')));
 app.use('/vendor',express.static(require('node:path').join(front,'node_modules')));
 app.get('/',(_req,res)=>res.sendFile(require('node:path').join(front,'scripts/qa/nc1-authenticated.html')));
 app.get('/qa-client.js',(_req,res)=>res.sendFile(require('node:path').join(front,'scripts/qa/nc1-authenticated-client.js')));
 app.use((err,_req,res,_next)=>{console.error('QA request error:',err.message);res.status(500).send({status:500,message:'QA error'});});
 const server=app.listen(33401,'127.0.0.1',()=>console.log('NC1_AUTH_QA_READY '+database));
 async function close(){await new Promise(r=>server.close(r));await db.close();await conn.end();process.exit(0);}process.on('SIGINT',close);process.on('SIGTERM',close);
}
main().catch(e=>{console.error(e);process.exit(1);});

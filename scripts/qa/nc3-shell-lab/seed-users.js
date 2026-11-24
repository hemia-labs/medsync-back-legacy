const mysql=require('mysql2/promise');
const {encript}=require('../../../src/util/bcrypt');
(async()=>{const c=await mysql.createConnection({host:'127.0.0.1',port:33950,user:'root',database:'medsync_shell'});
const hash=await encript('Lab-NC3-ShellPass-2026');
await c.query("INSERT INTO business(id_business,name,slug,active,status,subscription_status) VALUES ('lab_clinic','Consultorio Laboratorio NC3','lab-nc3',1,'active','active') ON DUPLICATE KEY UPDATE active=1");
const users=[['lab_valeria','r_doctor','Valeria','valeria@lab.example.test'],['lab_sofia','r_reception','Sofía','sofia@lab.example.test']];
for(const [id,rol,name,email] of users) await c.query("INSERT INTO login(id_login,id_business,id_rol,name,email,password,locked,active) VALUES (?,?,?,?,?,?,0,1) ON DUPLICATE KEY UPDATE password=VALUES(password),active=1,locked=0",[id,'lab_clinic',rol,name,email,hash]);
await c.query("INSERT INTO doctor_professional_profile(id_doctor_professional_profile,id_business,id_login,professional_name,professional_license,is_active) VALUES ('lab_prof','lab_clinic','lab_valeria','Dra. Valeria Prueba','CED-LAB-01',1) ON DUPLICATE KEY UPDATE is_active=1");
await c.query("INSERT INTO person(id_person,id_business,code,name,surname) VALUES ('lab_pat1','lab_clinic','100001','Paciente','Sintético Uno') ON DUPLICATE KEY UPDATE name=name");
console.log('ok');await c.end()})().catch(e=>{console.log('ERR',e.message)})

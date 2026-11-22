const mysql=require('mysql2/promise');
(async()=>{const c=await mysql.createConnection({host:'127.0.0.1',port:33950,user:'root',database:'medsync_shell'});
await c.query('CREATE TABLE IF NOT EXISTS patient_code_counter (singleton TINYINT NOT NULL PRIMARY KEY, next_value INT UNSIGNED NOT NULL)');
await c.query('INSERT INTO patient_code_counter(singleton,next_value) VALUES(1,1) ON DUPLICATE KEY UPDATE singleton=singleton');
const roles=[['r_admin','admin','Administrador'],['r_doctor','doctor','Doctor'],['r_assistant','assistant','Asistente'],['r_reception','reception','Recepción'],['r_super','super_admin','Super admin']];
for(const [id,code,d] of roles) await c.query('INSERT IGNORE INTO rol(id_rol,desc_rol,code,active) VALUES (?,?,?,1)',[id,d,code]);
const codes=['admin.config','admin.users','clinical_history.edit_draft','px.all','px.new','px.tab.monitoring','px.tab.odontogram','px.tab.treatment','px.tab.photos','px.radiography','px.dates','prescriptions.global','tracing.cancel','tracing.correct','tracing.create','treatments.cancel','treatments.cost_edit','treatments.cost_view','treatments.create','treatments.edit','treatments.view','treatments.complete'];
let n=0;for(const code of codes){n++;await c.query('INSERT IGNORE INTO cat_permission(id_cat_permission,code,name,description,sec,active,is_active) VALUES (?,?,?,?,?,1,1)',['perm_'+n,code,code,code,n]);}
const [perms]=await c.query('SELECT id_cat_permission,code FROM cat_permission');
const grant=async(role,list)=>{for(const p of perms) if(list===null||list.includes(p.code)) await c.query('INSERT IGNORE INTO permission_rol(id_permission_rol,id_cat_permission,id_rol,active) VALUES (?,?,?,1)',['pr_'+role+'_'+p.id_cat_permission,p.id_cat_permission,role]);};
await grant('r_admin',null);await grant('r_doctor',null);await grant('r_assistant',['px.dates','px.all','px.new']);await grant('r_reception',['px.dates']);
console.log('seeded',perms.length);await c.end()})()

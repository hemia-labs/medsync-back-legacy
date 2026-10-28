'use strict';
const fs = require('node:fs'), path = require('node:path');
const base = require('./co25-a2-mysql-fixture');
const inject = (file, value) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports: value }; };
async function createFixture() {
  const f = await base.createFixture();
  try {
    await f.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of ['address','query','allergy']) await f.query(fs.readFileSync(path.resolve(__dirname,'../../../u575589445_orrico/Tables',table+'.sql'),'utf8').match(/CREATE TABLE[\s\S]*?;\s*$/)[0]);
    await f.query('SET FOREIGN_KEY_CHECKS=1');
    await f.query('CREATE TABLE patient_code_counter(singleton TINYINT PRIMARY KEY,next_value BIGINT NOT NULL)');
    await f.query('INSERT INTO patient_code_counter VALUES(1,1000)');
    for (const permission of ['px.dates','px.all','px.new','admin.config']) {
      await f.query('INSERT INTO cat_permission(id_cat_permission,code,name,description) VALUES(:p,:p,\'QA\',\'QA\')', {p:permission});
      await f.query('INSERT INTO permission_rol(id_permission_rol,id_cat_permission,id_rol) VALUES(:p,:p,\'qa-role\')', {p:permission});
    }
    await f.query("UPDATE rol SET code='assistant' WHERE id_rol='qa-role'");
    const roles = { dates: ['px.dates'], identity: ['px.dates','px.all'], monitoring: ['px.tab.monitoring'], creator: ['px.new'], second: ['px.dates','px.all','px.new','px.tab.monitoring'] };
    for (const [role, permissions] of Object.entries(roles)) {
      await f.query('INSERT INTO rol(id_rol,desc_rol,code) VALUES(:r,:r,:r)', {r:role});
      await f.query('INSERT INTO login(id_login,id_business,id_rol,active) VALUES(:actor,\'qa-clinic\',:role,1)', {actor:'qa-'+role,role});
      for(const p of permissions) await f.query('INSERT INTO permission_rol(id_permission_rol,id_cat_permission,id_rol) SELECT :id,id_cat_permission,:role FROM cat_permission WHERE code=:p', {id:role+'-'+p,role,p});
    }
    await f.query("INSERT INTO person(id_person,id_business,name,surname,active) VALUES('qa-patient-2','qa-clinic','Segundo','Paciente',1),('archived-patient','qa-clinic','Archivado','QA',0),('foreign-patient','other-clinic','Ajeno','QA',1)");
    await f.query('UPDATE rol SET active=1');
    inject('../../src/config/config', { BUCKETS: {} });
    inject('../../src/services/aws/s3', { uploadImage: async () => { throw Error('External upload forbidden in fixture'); } });
    return f;
  } catch(error) { await f.close(); throw error; }
}
async function createHttp(f) {
  inject('../../src/auth/authenticate', { Auth(req,res,next) { const role=req.headers['x-qa-role']; if(role==='anonymous')return res.status(401).json({status:401}); req.tokenDecode={...f.body, id_login:role?'qa-'+role:f.body.id_login,id_business:req.headers['x-qa-tenant']||f.body.id_business}; next(); } });
  inject('../../src/middleware/requireTenantOperational.middleware',(_req,_res,next)=>next());
  inject('../../src/middleware/csrf.middleware',{csrfProtection:()=> (_req,_res,next)=>next()});
  inject('../../src/Dao/mysql/user.dao',{hasPermission: require('../../src/util/effectivePermissions').hasPermission});
  inject('../../src/services/security/securityLogger.service',{record(){}});
  const app=require('express')(); app.use(require('express').json()); const writes=[];
  app.use((req,_res,next)=>{if(req.method!=='GET')writes.push({method:req.method,path:req.path,body:req.body});next();});
  app.use('/api/appointment',require('../../src/routes/mysql/appointment'));
  app.use('/api/px',require('../../src/routes/mysql/px'));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  return {app,writes,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
module.exports={createFixture,createHttp};

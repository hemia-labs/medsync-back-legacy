const assert=require('node:assert/strict');
const mysql=require('mysql2/promise');
const c=require('../../src/config/config');

(async()=>{
 const connection=await mysql.createConnection({host:c.HOSTMYSQL,port:c.PORTMYSQL,user:c.USERMYSQL,password:c.PASSWORDMYSQL,database:c.DATABASEMYSQL});
 let serial=0;
 const db={
  async query(sql,options={}) {
   const args=[];const statement=sql.replace(/:([A-Za-z_]\w*)/g,(_,key)=>{assert.ok(Object.hasOwn(options.replacements || {},key),key);const value=options.replacements[key];args.push(value);return '?';});
   const [rows]=await connection.query(statement,args);
   if(/^CALL /i.test(sql))return rows[0];return Array.isArray(rows)?rows:[rows.affectedRows];
  },
  async transaction(callback) {
   const name=`s10_${++serial}`;await connection.query(`SAVEPOINT ${name}`);
   const transaction={async commit(){await connection.query(`RELEASE SAVEPOINT ${name}`);},async rollback(){await connection.query(`ROLLBACK TO SAVEPOINT ${name}`);await connection.query(`RELEASE SAVEPOINT ${name}`);}};
   if(!callback)return transaction;
   try{const result=await callback(transaction);await transaction.commit();return result;}catch(error){await transaction.rollback();throw error;}
  }
 };
 const dbPath=require.resolve('../../src/db/Sequelize.connection');require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:db};
 try {
  await connection.beginTransaction();
  const admin={actorLoginId:'QA_LOGIN_CLINICAL',idBusiness:'QA_BUSINESS_CLINICAL'};
  const doctor={actorLoginId:'QAC_DOCTOR_1',idBusiness:admin.idBusiness};
  const roles=require('../../src/Dao/mysql/rol.dao');
  const effective=require('../../src/util/effectivePermissions');
  const user=require('../../src/Dao/mysql/user.dao');
  const rx=require('../../src/Dao/mysql/prescription.dao');
  const [globalBefore]=await connection.query('SELECT * FROM permission_rol ORDER BY id_permission_rol');
  const initial=await roles.getPermissions('ROL-DOCTOR',admin);assert.equal(initial.status,200,initial.message);
  const codes=initial.data.filter(row=>Number(row.allowed)===1).map(row=>row.code);assert.ok(codes.includes('prescriptions.config'));
  assert.equal((await roles.getPermissions('ROL-DOCTOR',doctor)).status,403);
  assert.equal((await roles.savePermissions('ROL-DOCTOR',codes,doctor)).status,403);
  assert.equal((await roles.savePermissions('ROL-DOCTOR',codes,{...admin,idBusiness:'QA_BUSINESS_PROFESSIONAL'})).status,403,'Actor cannot operate another consultorio');
  assert.equal((await roles.savePermissions('ROL-DOCTOR',[...codes,'admin.users'],admin)).status,403,'Only administrator roles may hold administration');
  assert.equal((await roles.savePermissions('ROL-ADMIN',[],admin)).status,403,'Prevent locking all administrators out');
  const saved=await roles.savePermissions('ROL-DOCTOR',codes.filter(code=>!['prescriptions.config','treatments.cost_view'].includes(code)),admin);assert.equal(saved.status,200,saved.message);
  assert.equal(await user.hasPermission('QAC_DOCTOR_1','prescriptions.config'),false);
  assert.equal(await rx.hasPermission('QAC_DOCTOR_1','prescriptions.config'),false);
  assert.equal(await user.hasPermission('QAP_DOCTOR_1','prescriptions.config'),true,'Other consultorio using the same role must inherit its unchanged default');
  assert.ok(!(await effective.rows('QAC_DOCTOR_1')).some(row=>row.code==='prescriptions.config'),'Session hydration uses tenant denials');
  const TreatmentPlan=require('../../src/Dao/mysql/treatmentPlan.dao');const treatment=new TreatmentPlan();assert.equal((await treatment.permissions('QAC_DOCTOR_1')).costView,false);
  const foreign=await roles.getPermissions('ROL-DOCTOR',{actorLoginId:'QA_LOGIN_PROFESSIONAL',idBusiness:'QA_BUSINESS_PROFESSIONAL'});assert.equal(foreign.status,200);assert.equal(Number(foreign.data.find(row=>row.code==='prescriptions.config').allowed),1);
  // Explicit test grant still cannot turn a clinical role into administrator.
  const [adminCode]=await connection.query("SELECT id_cat_permission FROM cat_permission WHERE code='admin.users'");
  await connection.query('INSERT INTO business_role_permission (id_business,id_rol,id_cat_permission,active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE active=1',[doctor.idBusiness,'ROL-DOCTOR',adminCode[0].id_cat_permission]);
  assert.equal(await effective.isTenantAdministrator(doctor.actorLoginId,doctor.idBusiness,'admin.users'),false);
  assert.equal((await roles.savePermissions('ROL-DOCTOR',codes,doctor)).status,403);
  const [globalAfter]=await connection.query('SELECT * FROM permission_rol ORDER BY id_permission_rol');assert.deepEqual(globalAfter,globalBefore,'Global role defaults never change');
  console.log('PASS S10 real SQL/DAO: administrative and cross-tenant denial, protected administrator access, isolated tenant overrides, shared defaults unchanged, runtime/session and treatment permission readers. One connection; all writes rolled back.');
 } finally {await connection.rollback();await connection.end();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const mysql=require('mysql2/promise'),M=require('../migrations/nc1-identity');
test('NC1 R11/R12: tenant parent FK, strict code CHECK and audited explicit installation outside QA prefix',{skip:process.env.NC1_ISOLATED_QA!=='1'},async()=>{
 const conn=await mysql.createConnection({host:'127.0.0.1',port:33381,user:'root',password:'nc1-synthetic-only'});
 const database='nc1_install_fixture_'+Date.now();
 try {
  await conn.query('CREATE DATABASE '+database+' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');await conn.changeUser({database});
  await assert.rejects(()=>M.apply(conn,{isolated:true}));
  await assert.rejects(()=>M.apply(conn,{expectedDatabase:database,expectedChecksum:'wrong',actor:'qa'}));
  for(const [table,key] of [['person','id_person'],['doctor_professional_profile','id_doctor_professional_profile']])await conn.query(`CREATE TABLE ${table}(id_business VARCHAR(50),${key} VARCHAR(50) PRIMARY KEY)`);
  const opts={expectedDatabase:database,expectedChecksum:M.checksum,actor:'qa-operator'};
  await M.apply(conn,opts);
  // Exercise the operator CLI entrypoint with explicit synthetic config, without loading .env.
  const configPath=require.resolve('../../src/config/config');
  require.cache[configPath]={id:configPath,filename:configPath,loaded:true,exports:{HOSTMYSQL:'127.0.0.1',PORTMYSQL:33381,USERMYSQL:'root',PASSWORDMYSQL:'nc1-synthetic-only',DATABASEMYSQL:database}};
  const cli=require('../migrations/install-nc1-identity');
  await assert.rejects(()=>cli.main(['apply',database,'wrong','qa-operator']));
  await assert.rejects(()=>cli.main(['apply','wrong_database',M.checksum,'qa-operator']));
  await cli.main(['apply',database,M.checksum,'qa-operator']);
  const [[audit]]=await conn.query("SELECT COUNT(*) n FROM nc1_identity_audit WHERE state='complete' AND actor='qa-operator'");assert.equal(audit.n,2);
  await conn.query("INSERT INTO person VALUES ('tenant','p')");
  const insert="INSERT INTO patient_identity (id_business,id_person,updated_at,updated_by) VALUES (?,?,NOW(),'qa')";
  await assert.rejects(()=>conn.execute(insert,['other','p']),e=>e.code==='ER_NO_REFERENCED_ROW_2');
  await assert.rejects(()=>conn.execute(insert,['tenant','missing']),e=>e.code==='ER_NO_REFERENCED_ROW_2');
  await conn.execute(insert,['tenant','p']);
  await assert.rejects(()=>conn.query("DELETE FROM person WHERE id_person='p'"),e=>e.code==='ER_ROW_IS_REFERENCED_2');
  await assert.rejects(()=>conn.query("UPDATE person SET id_business='other' WHERE id_person='p'"),e=>e.code==='ER_ROW_IS_REFERENCED_2');
  for(const code of ['', 'bad code',' x','x\t'])await assert.rejects(()=>conn.execute("UPDATE patient_identity SET birth_country_family='sis.country',birth_country_code=? WHERE id_person='p'",[code]),e=>e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
  await conn.query("UPDATE patient_identity SET birth_country_family='sis.country',birth_country_code='001' WHERE id_person='p'");
  for(const code of ['', 'bad code'])await assert.rejects(()=>conn.execute("INSERT INTO patient_identity_affiliation VALUES ('tenant','p',0,'sis.affiliation',NULL,?)",[code]),e=>e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
  const [[fks]]=await conn.query("SELECT COUNT(*) n FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME LIKE 'sis_catalog%'");assert.equal(fks.n,0);
  await conn.query('ALTER TABLE patient_identity ADD COLUMN drift INT');await assert.rejects(()=>M.apply(conn,opts),/Deriva/);
  const [[failed]]=await conn.query("SELECT COUNT(*) n FROM nc1_identity_audit WHERE state='failed'");assert.equal(failed.n,1);
 }finally{await conn.end();}
});

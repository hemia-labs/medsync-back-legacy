'use strict';
// Real JWT/session, permission SQL, router, DAO and MySQL. All table identifiers
// are mapped to a fresh, random QA prefix. One physical connection, as required
// by AGENTS.md. Concurrent HTTP requests queue on that pool; this is not a
// multi-connection InnoDB deadlock/load benchmark. Never touches live rows.
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path');
const {ddl,migrate}=require('../migrations/co26-odontogram');
const {recover,compensateEmpty}=require('../migrations/co26-recovery');
(async()=>{
 if(!process.argv.includes('--configured'))throw Error('EXPLICIT_TARGET_REQUIRED');
 const config=require('../../src/config/config');
 // Test-only authentication secrets. Never use, print or change configured secrets.
 Object.assign(process.env,{NODE_ENV:'test',AUTH_COOKIE_MODE:'legacy',BROWSER_AUTH_TRANSPORT:'authorization',CSRF_ENABLED:'true',CSRF_ORIGIN_CHECK_ENABLED:'true',CSRF_ALLOWED_ORIGINS:'http://localhost:8347',CSRF_HEADER_NAME:'X-CSRF-Token',CSRF_TOKEN_SECRET:randomBytes(48).toString('hex'),JWT_SECRET:randomBytes(48).toString('hex'),CORS_ALLOWED_ORIGINS:'http://localhost:8347',SECURITY_LOG_ENABLED:'false'});
 const {Sequelize,QueryTypes}=require('sequelize');
 const sql=new Sequelize(config.DATABASEMYSQL,config.USERMYSQL,config.PASSWORDMYSQL,{host:config.HOSTMYSQL,port:config.PORTMYSQL,dialect:'mysql',logging:false,pool:{max:1,min:1,idle:600000},dialectOptions:{connectTimeout:15000}});
 const prefix='_co26qa_'+randomBytes(6).toString('hex')+'_';
 const fixtures={
  clinical_module_config:'id_business VARCHAR(50) NOT NULL PRIMARY KEY',
  cat_tooth:'id_tooth VARCHAR(50) NOT NULL PRIMARY KEY, sec INT NOT NULL',
  cat_permission:'id_cat_permission VARCHAR(50) NOT NULL PRIMARY KEY,code VARCHAR(80) UNIQUE,name VARCHAR(100),description VARCHAR(200),sec INT,value VARCHAR(80),active TINYINT,is_active TINYINT,created_at DATETIME',
  rol:'id_rol VARCHAR(50) NOT NULL PRIMARY KEY,code VARCHAR(50),desc_rol VARCHAR(80),active TINYINT',
  login:'id_login VARCHAR(50) NOT NULL PRIMARY KEY,id_business VARCHAR(50),id_rol VARCHAR(50),active TINYINT',
  session:'id_session VARCHAR(50) NOT NULL PRIMARY KEY,id_login VARCHAR(50),active TINYINT,`last` TINYINT',
  business:'id_business VARCHAR(50) NOT NULL PRIMARY KEY,active TINYINT,status VARCHAR(30),subscription_status VARCHAR(30),trial_starts_at DATETIME,trial_ends_at DATETIME,current_period_starts_at DATETIME,current_period_ends_at DATETIME,suspended_at DATETIME,cancelled_at DATETIME,status_reason VARCHAR(80)',
  person:'id_person VARCHAR(50) NOT NULL PRIMARY KEY,id_business VARCHAR(50),active TINYINT',
  patient_treatment:'id_business VARCHAR(50),id_patient_treatment VARCHAR(50),active TINYINT',
  permission_rol:'id_rol VARCHAR(50),id_cat_permission VARCHAR(50),active TINYINT',
  business_role_permission:'id_business VARCHAR(50),id_rol VARCHAR(50),id_cat_permission VARCHAR(50),active TINYINT',
  odontogramv1:'id_odontogramv1 VARCHAR(50),id_business VARCHAR(50),id_person VARCHAR(50),is_active TINYINT,active TINYINT',
  odontogramDetailv1:'id_odontogramv1 VARCHAR(50),id_tooth VARCHAR(50),treatment VARCHAR(1000),active TINYINT,is_active TINYINT'
 };
 const tables=[...Object.keys(fixtures),...ddl.map(([table])=>table)];
 const pattern=new RegExp('(?<!AS )(?<!:)\\b('+[...tables].sort((a,b)=>b.length-a.length).join('|')+')\\b','g');
 const translate=text=>text.replace(pattern,name=>prefix+name);
 const originalQuery=sql.query.bind(sql);
 const remap=value=>typeof value==='string'&&tables.includes(value)?prefix+value:value;
 const unmap=value=>typeof value==='string'?value.replaceAll(prefix,''):value;
 const db={
  async query(text,values=[]){const result=await originalQuery(translate(text),{replacements:values.map(remap),logging:false});const rows=result[0];return [Array.isArray(rows)?rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,unmap(v)]))):rows,result[1]];},
  beginTransaction:()=>originalQuery('START TRANSACTION'),commit:()=>originalQuery('COMMIT'),rollback:()=>originalQuery('ROLLBACK')
 };
 // Use the real Sequelize query/transaction implementation and its single pool.
 sql.query=(text,options={})=>originalQuery(translate(text),{...options,logging:false});
 const connection=require.resolve('../../src/db/Sequelize.connection');require.cache[connection]={id:connection,filename:connection,loaded:true,exports:sql};
 const checks=[];let server,cleaned=false;
 try {
  for(const [name,fields]of Object.entries(fixtures))await originalQuery(`CREATE TABLE ${prefix+name} (${fields}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const {sequence}=require('../../src/domain/odontogram/dentalContract');
  for(const tooth of sequence('mixed'))await db.query('INSERT INTO cat_tooth(id_tooth,sec) VALUES(?,?)',['qa-'+tooth,tooth]);
  const backups={};await migrate(db,async(name,value)=>{backups[name]=JSON.parse(JSON.stringify(value));});
  await db.query("UPDATE cat_permission SET name='Reviewed by QA admin' WHERE code='odontogram.capture'");
  await db.query('INSERT INTO permission_rol VALUES(?,?,1)',['future-role','PERM-CO26-FINALIZE']);
  await assert.rejects(()=>compensateEmpty(db,backups['install-plan.json'],[]),/STOP_ALL_WRITERS/);
  const compensation=await compensateEmpty(db,backups['install-plan.json'],backups['permission-created.json'],{maintenance:true});assert.equal(compensation.removed_tables.length,ddl.length);assert.equal(compensation.preserved_admin_permissions.length,2);checks.push('real_empty_compensation_preserves_later_admin_edits_and_grants');
  let ddlCount=0;const interrupted={...db,query:async(text,values)=>{if(text.startsWith('CREATE TABLE IF NOT EXISTS')&&++ddlCount===4)throw Error('QA_INTERRUPTION');return db.query(text,values);}};
  await assert.rejects(()=>migrate(interrupted,async()=>{}),/QA_INTERRUPTION/);
  await migrate(db,async()=>{});await migrate(db,async()=>{});checks.push('real_ddl_interruption_resume_and_reentrant_install');
  const business='qa-one',other='qa-two',patient='qa-patient',actor='qa-capture';
  for(const tenant of [business,other]){await db.query("INSERT INTO business(id_business,active,subscription_status) VALUES(?,1,'active')",[tenant]);await db.query("INSERT INTO clinical_module_config(id_business,odontogram_mode) VALUES(?,'v2')",[tenant]);}
  await db.query('INSERT INTO person VALUES(?,?,1)',[patient,business]);
  for(const [id,role,tenant]of [[actor,'capture',business],['qa-second','capture',business],['qa-finalize','finalize',business],['qa-other','capture',other],['qa-future','new-role',business],['qa-platform','super_admin',null]]){
   await db.query('INSERT IGNORE INTO rol VALUES(?,?,?,1)',[role,role,role]);await db.query('INSERT INTO login VALUES(?,?,?,1)',[id,tenant,role]);await db.query('INSERT INTO `session` VALUES(?,?,1,1)',['session-'+id,id]);
  }
  for(const [code,roles]of [['px.tab.odontogram',['capture','finalize']],['odontogram.capture',['capture']],['odontogram.finalize',['finalize']],['treatments.view',['capture']],['admin.config',['capture']]]){
   await db.query("INSERT IGNORE INTO cat_permission(id_cat_permission,code,active,is_active) VALUES(?,?,1,1)",[code,code]);
   const [rows]=await db.query('SELECT id_cat_permission FROM cat_permission WHERE code=?',[code]);for(const role of roles)await db.query('INSERT INTO permission_rol VALUES(?,?,1)',[role,rows[0].id_cat_permission]);
  }
  const express=require('express'),cookieParser=require('cookie-parser');const app=express();app.use(express.json(),cookieParser());
  app.use('/api/odontogram',require('../../src/routes/mysql/odontogram'));
  app.use('/api/super-admin/odontogram-aliases',require('../../src/routes/mysql/odontogramGlobalAliases'));
  app.use((error,req,res,next)=>{console.error('QA router failure:',error.name,error.original&&error.original.code,error.original&&error.original.sqlMessage||error.message);res.status(500).send({code:error.code||'QA_ERROR'});});
  server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  const root='http://127.0.0.1:'+server.address().port;
  const Token=require('../../src/auth/authenticate'),csrf=require('../../src/services/security/csrfToken.service'),cookie=require('../../src/config/authCookie.config');
  const cookieName=cookie.getCookieNames(cookie.getAuthCookieConfig()).csrf;
  const credentials=id=>{const tenant=id==='qa-other'?other:id==='qa-platform'?null:business;const claims={id_login:id,id_session:'session-'+id,id_business:tenant};return{jwt:Token.GetAccessToken(claims).token,csrf:csrf.issueToken({tokenDecode:claims}).token};};
  const users=Object.fromEntries([actor,'qa-second','qa-finalize','qa-other','qa-future','qa-platform'].map(id=>[id,credentials(id)]));
  async function request(id,method,url,body,validCsrf=true){const user=users[id];const response=await fetch(root+url,{method,headers:{...(user?{Authorization:'Bearer '+user.jwt}:{}),Origin:'http://localhost:8347',...(user&&validCsrf?{'X-CSRF-Token':user.csrf,Cookie:cookieName+'='+user.csrf}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};}
  const base='/api/odontogram/v2';
  assert.equal((await request(null,'GET',base+'/charts/'+patient)).status,401);
  assert.equal((await request(actor,'POST',base+'/charts/'+patient,{request_id:randomUUID(),mode:'mixed'},false)).status,403);
  const created=await request(actor,'POST',base+'/charts/'+patient,{request_id:randomUUID(),mode:'mixed'});assert.equal(created.status,200);const chart=created.body.data;checks.push('real_jwt_session_csrf_and_create_52');
  assert.equal((await request('qa-other','GET',base+'/chart/'+chart.id_chart)).status,404);assert.equal((await request('qa-platform','GET',base+'/chart/'+chart.id_chart)).status,403);
  assert.equal((await request(actor,'POST',base+'/chart/'+chart.id_chart+'/finalize',{request_id:randomUUID(),expected_revision:0,generation:1})).status,403);checks.push('two_tenants_and_independent_finalize_permission');
  const D=require('../../src/domain/odontogram/operations');
  const batch=text=>({batch_id:randomUUID(),base_revision:0,generation:1,catalog_version:D.CATALOG_VERSION,alias_version:chart.alias_version,ops:[{client_op_id:randomUUID(),type:'note.set',tooth:16,text}]});
  const race=await Promise.all([request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',batch('First')),request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',batch('Second'))]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);checks.push('concurrent_authenticated_same_tooth_one_commit_one_conflict');
  const winner=race.find(r=>r.status===200).body.data;
  const retryBatch={...batch('Same intention'),base_revision:winner.revision,ops:[{client_op_id:randomUUID(),type:'note.set',tooth:17,text:'Same intention'}]};
  const retries=await Promise.all([request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',retryBatch),request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',retryBatch)]);
  assert.deepEqual(retries.map(r=>r.status),[200,200]);assert.deepEqual(retries[0].body.data,retries[1].body.data);checks.push('concurrent_same_batch_one_revision_identical_receipts');
  const distinct=await Promise.all([request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',{...batch('One'),base_revision:2,ops:[{client_op_id:randomUUID(),type:'note.set',tooth:18,text:'One'}]}),request('qa-second','POST',base+'/chart/'+chart.id_chart+'/ops',{...batch('Two'),base_revision:2,ops:[{client_op_id:randomUUID(),type:'note.set',tooth:15,text:'Two'}]})]);assert.deepEqual(distinct.map(r=>r.status),[200,200]);
  let latest=(await request(actor,'GET',base+'/chart/'+chart.id_chart)).body.data;assert.equal(latest.revision,4);assert.equal(latest.teeth[18].note,'One');assert.equal(latest.teeth[15].note,'Two');checks.push('concurrent_two_operators_distinct_teeth_merge');
  const overlap=await Promise.all([request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',{...batch('A'),base_revision:4,ops:[{client_op_id:randomUUID(),type:'note.set',tooth:13,text:'A'}]}),request('qa-second','POST',base+'/chart/'+chart.id_chart+'/ops',{...batch('B'),base_revision:4,ops:[{client_op_id:randomUUID(),type:'note.set',tooth:13,text:'B'}]})]);assert.deepEqual(overlap.map(r=>r.status).sort(),[200,409]);checks.push('concurrent_two_operators_same_tooth_conflict');
  const findingId=randomUUID();let finding=(await request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',{...batch(''),base_revision:5,ops:[{client_op_id:findingId,type:'finding.add',tooth:16,code:'car',surfaces:'MO'}]}));assert.equal(finding.status,200);
  const dental=require('../../src/services/odontogramPlanDental.service'),treatment='qa-treatment';
  const planBody={id_business:business,id_person:patient,id_login:actor,dental_revision:0,tooth_details:[{tooth_number:'16',manual:true,manual_surfaces:'D',sources:[{id_chart:chart.id_chart,finding_id:findingId,revision:6}]}]};
  let prepared=await dental.prepare(planBody,treatment,[],null,true);await dental.persist(planBody,treatment,prepared,null);await db.query('INSERT INTO patient_treatment VALUES(?,?,1)',[business,treatment]);
  let linked=await request(actor,'GET',base+'/chart/'+chart.id_chart+'/plan-links');assert.equal(linked.status,200);assert.equal(Number(linked.body.data.links[0].related_count),1);assert.equal(linked.body.data.links[0].cost,undefined);
  finding=await request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',{...batch(''),base_revision:6,ops:[{client_op_id:randomUUID(),type:'finding.surface',tooth:16,finding_id:findingId,surfaces:'V'}]});assert.equal(finding.status,200);
  const replacement={...planBody,dental_revision:1,tooth_details:[{tooth_number:'16',sources:[{id_chart:chart.id_chart,finding_id:findingId,revision:7,replace_revision:6}]}]};
  prepared=await dental.prepare(replacement,treatment,['16'],null,true);await dental.persist(replacement,treatment,prepared,null);
  let plan=await dental.load(business,treatment,['16'],null);assert.equal(plan.details[0].surfaces,'DV');assert.equal(plan.details[0].manual_surfaces,'D');
  const withdrawal={...planBody,dental_revision:2,tooth_details:[{tooth_number:'16',remove_sources:[plan.details[0].sources[0].source_key]}]};prepared=await dental.prepare(withdrawal,treatment,['16'],null,true);await dental.persist(withdrawal,treatment,prepared,null);
  plan=await dental.load(business,treatment,['16'],null);assert.equal(plan.details[0].surfaces,'D');checks.push('real_plan_source_revision_replacement_withdrawal_and_private_duplicate_notice');
  assert.equal((await request('qa-future','GET',base+'/charts/'+patient)).status,403);
  await db.query("UPDATE cat_permission SET is_active=0 WHERE code='odontogram.capture'");assert.equal((await request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',{...batch('Disabled'),base_revision:7})).status,403);await db.query("UPDATE cat_permission SET is_active=1 WHERE code='odontogram.capture'");checks.push('new_role_requires_explicit_grants_and_disabled_catalog_denies');
  const finalization=await request('qa-finalize','POST',base+'/chart/'+chart.id_chart+'/finalize',{request_id:randomUUID(),expected_revision:7,generation:1});assert.equal(finalization.status,200);
  const afterCloseReceipt=await request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',retryBatch);assert.equal(afterCloseReceipt.status,200);assert.equal(afterCloseReceipt.body.data.revision,2);checks.push('confirmed_receipt_after_lifecycle_with_real_permissions');
  latest=finalization.body.data;
  const globals='/api/super-admin/odontogram-aliases';assert.equal((await request(actor,'GET',globals)).status,403);
  let globalState=await request('qa-platform','GET',globals);assert.equal(globalState.status,200);
  const globalSave=await request('qa-platform','PUT',globals,{alias:'globalqa',target:'car',expected_version:globalState.body.data.alias_version});assert.equal(globalSave.status,200);
  const stale=await request('qa-platform','PUT',globals,{alias:'globalqa',target:'res',expected_version:globalState.body.data.alias_version});assert.equal(stale.status,409);checks.push('platform_only_global_alias_versioned_audited');
  await db.query("UPDATE business_role_permission SET active=0 WHERE id_business=?",[business]);
  const [permission]=await db.query("SELECT id_cat_permission FROM cat_permission WHERE code='odontogram.capture'");
  await db.query('INSERT INTO business_role_permission VALUES(?,?,?,0)',[business,'capture',permission[0].id_cat_permission]);
  assert.equal((await request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',{...batch('Revoked'),base_revision:latest.revision})).status,403);checks.push('live_permission_revocation_without_new_token');
  const recovery=await recover(db,business,'v2');assert.equal(recovery.charts_retained,1);
  const after=await request(actor,'GET',base+'/chart/'+chart.id_chart);assert.equal(after.status,200);assert.equal(after.body.data.revision,latest.revision);
  await db.query('DELETE FROM business_role_permission WHERE id_business=?',[business]);
  const readonlyWrite=await request(actor,'POST',base+'/chart/'+chart.id_chart+'/ops',{...batch('Readonly'),base_revision:latest.revision,generation:latest.generation});assert.equal(readonlyWrite.status,409);
  for(const [method,url]of [['POST','/v1/detail'],['POST','/v1/save'],['PUT','/v1/status'],['DELETE','/v1/delete'],['POST','/save'],['PUT','/update']]){const blocked=await request(actor,method,'/api/odontogram'+url,{});assert.equal(blocked.status,409);assert.equal(blocked.body.code,'CO26_LEGACY_WRITE_BLOCKED');}checks.push('readonly_and_all_legacy_mutators_blocked_with_real_jwt');
  await assert.rejects(()=>compensateEmpty(db,{created_tables:ddl.map(([table])=>table),mode_added:true},[],{maintenance:true}),/DATA_PRESENT/);checks.push('destructive_compensation_refused_when_clinical_data_exists');
  await assert.rejects(()=>recover(db,business,'v2'),/MODE_CHANGED/);checks.push('real_compensating_recovery_readonly_preserves_snapshots');
  await db.query('UPDATE `session` SET active=0 WHERE id_login=?',[actor]);assert.equal((await request(actor,'GET',base+'/chart/'+chart.id_chart)).status,401);checks.push('live_session_revocation');
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  // Only the explicit random QA prefix can be removed, in dependency order.
  assert.match(prefix,/^_co26qa_[a-f0-9]{12}_$/);
  for(const table of [...tables].reverse())await originalQuery('DROP TABLE IF EXISTS `'+prefix+table+'`');
  const remaining=await originalQuery('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LEFT(TABLE_NAME,:length)=:prefix',{replacements:{length:prefix.length,prefix},type:QueryTypes.SELECT});cleaned=remaining.length===0;
  await sql.close();
 }
 assert.equal(cleaned,true);
 await fs.writeFile(path.resolve(__dirname,'../../../roadmap/evidence/CO26/authenticated-mysql-results.json'),JSON.stringify({pass:true,checked_at:new Date().toISOString(),checks,real_authentication:true,real_mysql:true,single_connection:true,concurrent_http:true,multi_connection_lock_benchmark:false,live_rows_changed:false,qa_tables_removed:cleaned},null,2));
 console.log('PASS authenticated MySQL HTTP: '+checks.length+' scenarios; isolated QA tables removed. One physical connection; no live tenant rows changed.');
})().catch(error=>{console.error('CO26 authenticated QA:',error.code==='ERR_ASSERTION'?error.stack:error.code||error.message);process.exitCode=1;});

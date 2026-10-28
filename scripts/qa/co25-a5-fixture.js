'use strict';
// Full application/auth integration, on the marked disposable MySQL instance only.
// No .env, credential files, production data, mail, background jobs or external HTTP.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),http=require('node:http');
const {randomBytes,randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'../../..'),front=path.join(root,'hemia-assistance-front-legacy');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function preventEnvironmentFiles(){const id=require.resolve('../../src/config/env');require.cache[id]={id,filename:id,loaded:true,exports:{}};}
async function installSchema(f){
  const connection=await f.db.connectionManager.getConnection();
  const run=sql=>connection.promise().query(sql);
  try{
    await run('SET FOREIGN_KEY_CHECKS=0');
    const tables=new Set((await f.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')).map(t=>t.name));
    for(const file of fs.readdirSync(path.join(root,'u575589445_orrico/Tables')).filter(n=>n.endsWith('.sql'))){
      if(tables.has(file.slice(0,-4)))continue;
      const ddl=fs.readFileSync(path.join(root,'u575589445_orrico/Tables',file),'utf8').match(/CREATE TABLE[\s\S]*?;\s*$/)?.[0];
      if(!ddl)throw Error('Missing schema-only table: '+file);await run(ddl);
    }
    await run('CREATE TABLE IF NOT EXISTS patient_code_counter(singleton TINYINT PRIMARY KEY,next_value BIGINT NOT NULL)');
    await run('INSERT INTO patient_code_counter(singleton,next_value) VALUES(1,50000)');
    await run('CREATE UNIQUE INDEX uq_a5_person_code ON person(code)');
    for(const kind of ['Functions','Procedures'])for(const file of fs.readdirSync(path.join(root,'u575589445_orrico',kind)).filter(n=>n.endsWith('.sql'))){
      if(file==='SP_appointment_config_get.sql')continue;
      const source=fs.readFileSync(path.join(root,'u575589445_orrico',kind,file),'utf8');
      const ddl=source.slice(source.indexOf('CREATE '),source.lastIndexOf('//')).replace(/DEFINER=`[^`]+`@`[^`]+`\s*/,'').trim();
      if(!ddl.startsWith('CREATE ')||/u575589445_orrico/.test(ddl))throw Error('Unexpected routine schema: '+file);
      await run(ddl);
    }
    await run('SET FOREIGN_KEY_CHECKS=1');
  }finally{await f.db.connectionManager.releaseConnection(connection);}
}
async function seed(f){
  const permissions=['px.dates','px.all','px.new','px.tab.monitoring','tracing.create','tracing.correct','tracing.cancel','px.tab.history','clinical_history.view','clinical_history.view_sensitive','clinical_history.edit_draft','clinical_history.intake','admin.config'];
  for(const p of permissions)await f.query('INSERT IGNORE INTO cat_permission(id_cat_permission,code,name,description) VALUES(:p,:p,:p,\'Synthetic A5 permission\')',{p});
  const business=randomUUID(),foreignBusiness=randomUUID();
  for(const id of [business,foreignBusiness])await f.query("INSERT INTO business(id_business,name,slug,status,subscription_status,plan) VALUES(:id,'Consultorio QA A5',:id,'active','active','professional')",{id});
  const rolePermissions={agenda:['px.dates'],reception:['px.dates','px.all','px.new'],clinician:permissions.filter(p=>p!=='admin.config'),clinical_only:['px.all','px.tab.monitoring'],admin:permissions,foreign:permissions};
  const actors={};let n=0;
  for(const [name,grants]of Object.entries(rolePermissions)){
    const id=randomUUID(),role=randomUUID(),tenant=name==='foreign'?foreignBusiness:business,password=randomBytes(24).toString('base64url'),phone='55587000'+String(++n).padStart(2,'0');
    await f.query('INSERT INTO rol(id_rol,code,desc_rol,active) VALUES(:role,:code,:name,1)',{role,code:name==='admin'?'admin':'a5_'+name,name:'QA '+name});
    for(const permission of grants)await f.query('INSERT INTO permission_rol(id_permission_rol,id_cat_permission,id_rol) SELECT :id,id_cat_permission,:role FROM cat_permission WHERE code=:permission',{id:randomUUID(),role,permission});
    await f.query('INSERT INTO login(id_login,id_business,id_rol,name,telephone,email,password,locked,active,created_at) VALUES(:id,:tenant,:role,:name,:phone,:email,:hash,0,1,NOW())',{id,tenant,role,name:'QA '+name,phone,email:name+'@example.invalid',hash:await require('bcryptjs').hash(password,10)});
    actors[name]={id,role,business:tenant,phone,password,permissions:grants};
  }
  const doctor=randomUUID();await f.query("INSERT INTO doctor_professional_profile(id_doctor_professional_profile,id_business,id_login,professional_name) VALUES(:doctor,:business,:actor,'Doctor Sintetico A5')",{doctor,business,actor:actors.clinician.id});
  for(const id of [business,foreignBusiness]){
    await f.dao.readConfig(id,null);if(id===business)await f.dao.readConfig(id,doctor);
    await f.query('UPDATE appointment_config SET enabled=1 WHERE id_business=:id',{id});
    await f.query('UPDATE appointment_working_day SET enabled=1 WHERE id_business=:id',{id});
    await f.query('DELETE FROM appointment_time_range WHERE id_business=:id',{id});
    await f.query("INSERT INTO appointment_time_range(id_appointment_time_range,id_business,id_appointment_working_day,start_time,end_time) SELECT UUID(),id_business,id_appointment_working_day,'00:00','23:59' FROM appointment_working_day WHERE id_business=:id",{id});
  }
  const themeBlock=fs.readFileSync(path.join(front,'src/plugins/theme.js'),'utf8').match(/const DEFAULT_THEME = \{([\s\S]*?)\};/)[1];
  const colors=Object.fromEntries([...themeBlock.matchAll(/([a-z0-9_]+): '(#[A-Fa-f0-9]{6})'/g)].map(m=>[m[1],m[2]]));
  await f.query('INSERT INTO cat_ui_theme(id_cat_ui_theme,code,name,'+Object.keys(colors).join(',')+') VALUES(\'qa-a5-theme\',\'medical-blue\',\'QA medical blue\','+Object.keys(colors).map(k=>':'+k).join(',')+')',colors);
  return {business,foreignBusiness,actors,doctor};
}
async function start(){
  preventEnvironmentFiles();
  for(const key of Object.keys(process.env))if(/^(DB_|AWS_|MAIL_|SMTP_|EMAIL_|AUTH_|CSRF_|CORS_|JWT_|REFRESH_TOKEN_|REGISTRATION_|SESSION_|SAAS_|PULSE_)/.test(key))delete process.env[key];
  Object.assign(process.env,{NODE_ENV:'test',APP_ENV:'test',PORT:'0',AUTH_COOKIE_MODE:'d2',BROWSER_AUTH_TRANSPORT:'cookie',AUTH_COOKIE_SECURE:'true',AUTH_COOKIE_SAMESITE:'lax',AUTH_COOKIE_PATH:'/',AUTH_COOKIE_DOMAIN:'',AUTH_COOKIE_ACCESS_NAME:'__Host-co25_a5_at',AUTH_COOKIE_REFRESH_NAME:'__Host-co25_a5_rt',AUTH_CSRF_COOKIE_NAME:'__Host-co25_a5_csrf',CSRF_COOKIE_NAME:'__Host-co25_a5_csrf',CSRF_ENABLED:'true',CSRF_ORIGIN_CHECK_ENABLED:'true',CORS_CREDENTIALS:'true',REQUIRE_ACTIVE_SESSION:'true',JWT_SECRET:randomBytes(48).toString('hex'),REFRESH_TOKEN_SECRET:randomBytes(48).toString('hex'),JWT_EXPIRES_IN:'15m',EMAIL_PROVIDER:'disabled',SAAS_JOBS_ENABLED:'false',PULSE_JOBS_ENABLED:'false',REGISTRATION_ENABLED:'false',REGISTRATION_IDENTITY_ENABLED:'false',REGISTRATION_ACTIVATION_ENABLED:'false'});
  const f=await require('./co25-a2-mysql-fixture').createFixture();let server,tls;
  try{
    process.env.CSRF_TOKEN_SECRET=randomBytes(48).toString('hex');
    process.env.PASSWORD_RESET_CODE_SECRET=randomBytes(48).toString('hex');
    console.log('A5: installing schema-only snapshot in private MySQL');
    await installSchema(f);const ids=await seed(f);
    for(const transport of [http,https]){const request=transport.request;transport.request=function(options,...rest){const target=typeof options==='string'?new URL(options):options;const host=target.hostname||target.host||'localhost';if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))throw Error('External HTTP forbidden in A5');return request.call(this,options,...rest);};}
    const express=require('express'),web=express();
    const cert=require(path.join(front,'node_modules/selfsigned')).generate([{name:'commonName',value:'127.0.0.1'}],{days:1,keySize:2048,algorithm:'sha256',extensions:[{name:'subjectAltName',altNames:[{type:7,ip:'127.0.0.1'}]}]});
    tls=https.createServer({key:cert.private,cert:cert.cert},web);await new Promise(resolve=>tls.listen(0,'127.0.0.1',resolve));
    const origin='https://127.0.0.1:'+tls.address().port;
    Object.assign(process.env,{CORS_ALLOWED_ORIGINS:origin,CSRF_ALLOWED_ORIGINS:origin});
    // Bind the real index.js server to loopback and retain its shutdown handle.
    const listen=express.application.listen;
    express.application.listen=function(port,cb){server=listen.call(this,port,'127.0.0.1',cb);return server;};
    try{require('../../src/index');}finally{express.application.listen=listen;}
    if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
    const backend='http://127.0.0.1:'+server.address().port;
    for(let i=0;i<100;i++){if((await fetch(backend+'/readyz').catch(()=>({status:0}))).status===200)break;if(i===99)throw Error('Full backend readiness failed');await pause(100);}
    const {createProxyMiddleware:proxy}=require(path.join(front,'node_modules/http-proxy-middleware'));
    web.use('/api',proxy({target:backend,changeOrigin:false,logLevel:'silent'}));
    const build=path.join(root,'_qa/co25-a5/build');web.use(express.static(build));web.get('*',(_req,res)=>res.sendFile(path.join(build,'index.html')));
    return {...f,...ids,origin,build,async close(){await new Promise(resolve=>tls.close(resolve));await new Promise(resolve=>server.close(resolve));await f.close();}};
  }catch(error){if(tls)await new Promise(resolve=>tls.close(resolve));if(server)await new Promise(resolve=>server.close(resolve));await f.close();throw error;}
}
module.exports={start};

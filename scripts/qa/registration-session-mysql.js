'use strict';
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {Sequelize}=require('sequelize');
const name='medsync-registration-session-'+Date.now();
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
Object.assign(process.env,{NODE_ENV:'test',APP_ENV:'test',AUTH_COOKIE_MODE:'d2',BROWSER_AUTH_TRANSPORT:'cookie',AUTH_COOKIE_SECURE:'false',AUTH_COOKIE_DOMAIN:'',AUTH_COOKIE_PATH:'/',
  AUTH_COOKIE_ACCESS_NAME:'qa_at',AUTH_COOKIE_REFRESH_NAME:'qa_rt',AUTH_CSRF_COOKIE_NAME:'qa_csrf',AUTH_COOKIE_SAMESITE:'lax',JWT_EXPIRES_IN:'15m',CSRF_ENABLED:'true',CORS_CREDENTIALS:'true',CORS_ALLOWED_ORIGINS:'http://qa.invalid'});
require('../../src/config/security').getRefreshTokenSecret=()=> 'synthetic-refresh-key';
const tokens=require('../../src/services/security/refreshToken.service'),{state}=require('../../src/services/registration/registrationSession');
(async()=>{
 let db,started=false;
 try{
  docker('run','--detach','--rm','--name',name,'--memory','768m','--cpus','1','-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','-e','MYSQL_ROOT_HOST=%','-e','MYSQL_DATABASE=qa_session','-p','127.0.0.1::3306','mysql:8.4');started=true;
  const port=Number(docker('port',name,'3306/tcp').split(':').at(-1));
  db=new Sequelize('qa_session','root','',{host:'127.0.0.1',port,dialect:'mysql',logging:false,pool:{max:1}});
  for(let i=0;i<60;i++){try{await db.authenticate();break;}catch(error){if(i===59)throw error;await pause(500);}}
  await db.query('CREATE TABLE rol(id_rol VARCHAR(50),active TINYINT) COLLATE utf8mb4_unicode_ci');
  await db.query('CREATE TABLE login(id_login VARCHAR(50),id_rol VARCHAR(50),active TINYINT) COLLATE utf8mb4_unicode_ci');
  await db.query('CREATE TABLE `session`(id_session VARCHAR(50),id_login VARCHAR(50),active TINYINT,`last` TINYINT) COLLATE utf8mb4_unicode_ci');
  await db.query('CREATE TABLE refresh_token(id_refresh_token VARCHAR(50),id_login VARCHAR(50),id_session VARCHAR(50),token_hash CHAR(64),`last` TINYINT,revoked_at DATETIME,rotated_at DATETIME,reused_at DATETIME,expires_at DATETIME) COLLATE utf8mb4_unicode_ci');
  await db.query("INSERT INTO rol VALUES('role',1)");await db.query("INSERT INTO login VALUES('actor','role',1)");await db.query("INSERT INTO `session` VALUES('session','actor',1,1)");
  const token=tokens.createRefreshToken();
  await db.query("INSERT INTO refresh_token VALUES(:id,'actor','session',:hash,1,NULL,NULL,NULL,DATE_ADD(NOW(),INTERVAL 1 HOUR))",{replacements:{id:token.tokenId,hash:token.tokenHash}});
  const request={authTokenInvalid:true,cookies:{qa_rt:token.rawToken}};
  assert.equal(await state(request,db),'active');assert.equal(await state({cookies:{}},db),'anonymous');
  for(const field of ['revoked_at','rotated_at','reused_at']){
    await db.query('UPDATE refresh_token SET '+field+'=NOW()');assert.equal(await state(request,db),'expired');await db.query('UPDATE refresh_token SET '+field+'=NULL');
  }
  await db.query('UPDATE refresh_token SET expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND)');assert.equal(await state(request,db),'expired');
  await db.query('UPDATE refresh_token SET expires_at=DATE_ADD(NOW(),INTERVAL 1 HOUR)');
  for(const table of ['login','rol','session']){
    await db.query('UPDATE `'+table+'` SET active=0');assert.equal(await state(request,db),'expired');await db.query('UPDATE `'+table+'` SET active=1');
  }
  await db.query("UPDATE refresh_token SET id_session='other-session'");assert.equal(await state(request,db),'expired');await db.query("UPDATE refresh_token SET id_session='session'");
  const tampered=token.rawToken.slice(0,-1)+(token.rawToken.endsWith('x')?'y':'x');assert.equal(await state({authTokenInvalid:true,cookies:{qa_rt:tampered}},db),'expired');
  await db.query("UPDATE refresh_token SET id_refresh_token='legacy-qa',token_hash=NULL,id_session=NULL");
  assert.equal(await state({cookies:{qa_rt:'legacy-qa'}},db),'active');
  await db.query('UPDATE `session` SET `last`=0');assert.equal(await state({cookies:{qa_rt:'legacy-qa'}},db),'expired');
  console.log('PASS MySQL8.4: valid/expired/revoked/rotated/reused refresh, disabled actor/role/session, session binding, tampering, anonymous and legacy compatibility');
 }finally{if(db)await db.close();if(started)docker('rm','-f',name);}
})().catch(error=>{console.error(error);process.exitCode=1;});

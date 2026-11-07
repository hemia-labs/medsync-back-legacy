'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
function stub(file, exports) { const id = require.resolve(path.join(root,file)); require.cache[id]={id,filename:id,loaded:true,exports}; }
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
const image='data:image/png;base64,'+bytes.toString('base64');
let admin=false;
let uploads=[], signs=[], deletes=[], reads=[], journal=[], events=[], rows=[], failWrite=false, failCommit=false;
stub('src/config/config.js',{S3_PRIVATE_BUCKET:'qa-private'});
stub('src/config/aws/s3.js',{
 uploadBufferToBucket:async(Bucket,Body,Key,ContentType)=>{uploads.push({Bucket,Body,Key,ContentType});events.push('upload');return {Key,Location:'https://forbidden-direct.invalid/'+Key};},
 signGetObject:async(Bucket,Key,Expires)=>{signs.push({Bucket,Key,Expires});return 'https://signed.invalid/qa?expires='+Expires;},
 readObject:async(Bucket,Key)=>{reads.push({Bucket,Key});return {Body:bytes,ContentType:'image/png'};},
 deleteFileToBucket:async(Bucket,Key)=>{deletes.push({Bucket,Key});events.push('delete');}
});
stub('src/services/recoveryJournal.js',{recordUploadCleanup:async value=>journal.push(value)});
stub('src/db/Sequelize.connection.js',{
 transaction:async()=>({commit:async function(){events.push('commit');if(failCommit)throw Error('Synthetic commit lost');this.finished='commit';},rollback:async function(){events.push('rollback');this.finished='rollback';}}),
 query:async(sql,options)=>{
  if(sql.startsWith('SELECT logo_url')) {assert.equal(options.replacements.business,'tenant');return rows;}
  if(sql.startsWith('UPDATE business SET logo_url')){events.push('save');if(failWrite)throw Error('synthetic write');rows=[{logo_url:options.replacements.logo}];return [1];}
  throw Error('Unexpected query');
 }
});
stub('src/util/effectivePermissions.js',{isTenantAdministrator:async()=>admin, hasPermission:async()=>false});
const service=require(path.join(root,'src/services/aws/privateImages'));
const dao=require(path.join(root,'src/Dao/mysql/business.dao'));
dao.get=async()=>({status:200,success:true,data:{logoUrl:rows[0]?.logo_url}});
(async()=>{
 const logo=await service.upload(image,'tenant');
 assert.match(logo.Key,/^consultorios\/tenant\/logos\/[a-f0-9-]+\.png$/);
 assert.equal(uploads[0].Bucket,'qa-private');assert.ok(uploads[0].Body.equals(bytes));
 const signature=await service.upload(image,'tenant','doctor');
 assert.match(signature.Key,/^consultorios\/tenant\/profesionales\/doctor\/firmas\//);
 assert.equal(service.digest(signature.Key),service.digest(image));
 assert.equal(await service.signedImage(logo.Key,'tenant'),'https://signed.invalid/qa?expires=300');
 assert.equal(signs[0].Expires,300);
 assert.equal(await service.inlineImage(signature.Key,'tenant'),image,'Clinical snapshot embeds bytes and survives deletion');
 const calls=signs.length+reads.length;
 for(const key of [logo.Key.replace('/tenant/','/foreign/'),logo.Key.replace('/logos/','/../logos/'),logo.Key+'/../x.png']) {
  await assert.rejects(service.signedImage(key,'tenant'));await assert.rejects(service.inlineImage(key,'tenant'));
 }
 assert.equal(signs.length+reads.length,calls,'Foreign or malformed references rejected before AWS');
 await assert.rejects(service.upload(image,'../foreign'));
 await assert.rejects(service.upload('data:image/png;base64,PHN2Zz4=','tenant'));
 await assert.rejects(service.upload('data:image/svg+xml;base64,AAAA','tenant'));
 rows=[];const before=uploads.length;
 assert.equal((await dao.updateLogo('tenant',{image,id_login:'actor'})).status,404);
 assert.equal(uploads.length,before,'Missing tenant never uploads');
 rows=[{logo_url:logo.Key}];events=[];deletes=[];
 const saved=await dao.updateLogo('tenant',{image,id_login:'actor'});
 assert.equal(saved.status,200);assert.ok(service.isPrivateKey(saved.data.logoUrl));
 assert.deepEqual(events,['upload','save','commit','delete'],'Old image removed only after committed replacement');
 assert.equal(deletes[0].Key,logo.Key);
 const replacement=rows[0].logo_url;events=[];deletes=[];failWrite=true;
 assert.equal((await dao.updateLogo('tenant',{image,id_login:'actor'})).status,500);
 assert.equal(deletes.length,1);assert.notEqual(deletes[0].Key,replacement,'Rollback cleans only failed upload');
 failWrite=false;failCommit=true;events=[];deletes=[];
 const warn=console.warn;console.warn=()=>{};
 try{assert.equal((await dao.updateLogo('tenant',{image,id_login:'actor'})).status,500);}finally{console.warn=warn;}
 assert.equal(deletes.length,0,'Unknown commit never deletes potentially persisted image');assert.equal(journal.length,1);
 failCommit=false;rows=[{logo_url:replacement}];events=[];deletes=[];
 assert.equal((await dao.updateLogo('tenant',{id_login:'actor'},true)).status,200);
 assert.equal(rows[0].logo_url,null);assert.deepEqual(events,['save','commit','delete']);
 // Exercise real professional persistence and controller authorization with the same AWS double.
 const db=require(path.join(root,'src/db/Sequelize.connection'));
 let profile={id_doctor_professional_profile:'profile',professional_name:'QA',professional_license:'123',signature_image:signature.Key,is_active:1,can_sign_documents:1};
 stub('src/util/tracingPermissions.js',{seedTracingPermissions:async()=>{}});
 stub('src/util/dashboardAccess.js',{seedDashboardPermissions:async()=>{}});
 stub('src/util/licenseLimits.js',{validateLicenseForProfessionalProfile:async()=>({allowed:true})});
 db.query=async(sql,options)=>{
  if(sql.includes('SELECT id_business FROM business'))return [{id_business:'tenant'}];
  if(sql.includes('FROM login l'))return [{id_login:'doctor',id_business:'tenant',rol:'doctor'}];
  if(sql.includes('SELECT id_doctor_professional_profile'))return [{id_doctor_professional_profile:'profile'}];
  if(sql.includes('SELECT can_issue_prescriptions'))return [{...profile}];
  if(sql.includes('UPDATE doctor_professional_profile')){events.push('save');if(failWrite)throw Error('synthetic profile failure');profile={...profile,signature_image:options.replacements._signature_image};return [1];}
  throw Error('Unexpected profile query');
 };
 const user=require(path.join(root,'src/Dao/mysql/user.dao'));
 user.getProfessionalProfile=async()=>({status:200,success:true,data:{...profile}});
 const body={id_login:'doctor',target_id_login:'doctor',id_business:'tenant'};
 const uploadsBefore=uploads.length;
 assert.equal((await user.saveProfessionalProfile({...body,target_id_login:'other',signature_image:image})).status,401);
 assert.equal(uploads.length,uploadsBefore,'Unauthorized profile fails before AWS');
 assert.equal((await user.saveProfessionalProfile({...body,signature_image:logo.Key})).status,400,'Cannot forge another saved reference');
 events=[];deletes=[];
 assert.equal((await user.saveProfessionalProfile({...body,signature_image:image})).status,200);
 assert.match(profile.signature_image,/^consultorios\/tenant\/profesionales\/doctor\/firmas\//);
 assert.deepEqual(events,['upload','save','commit','delete']);
 const frozen=await service.inlineImage(profile.signature_image,'tenant');
 events=[];deletes=[];
 assert.equal((await user.saveProfessionalProfile({...body,signature_image:null})).status,200);
 assert.equal(profile.signature_image,null);assert.equal(frozen,image,'Issued signature bytes remain after profile deletion');
 assert.deepEqual(events,['save','commit','delete']);
 // No trust in a submitted tenant or actor, even for an admin-only logo route.
 const controller=require(path.join(root,'src/controller/mysql/business.controller'));
 const res={set(){return this;},status(code){this.code=code;return this;},send(value){this.value=value;return this;}};
 let logoCalled=false;dao.updateLogo=async()=>{logoCalled=true;};
 await controller.updateLogo({tokenDecode:{id_business:'tenant',id_login:'actor'},body:{id_business:'foreign',image},method:'PUT'},res);
 assert.equal(res.code,403);assert.equal(logoCalled,false,'Administrator gate rejects before DAO/S3');
 admin=true;
 dao.updateLogo=async(business,body,remove)=>{assert.equal(business,'tenant');assert.equal(body.id_login,'actor');assert.equal(remove,false);return {status:200,success:true,data:{logoUrl:logo.Key}};};
 await controller.updateLogo({tokenDecode:{id_business:'tenant',id_login:'actor'},body:{id_business:'foreign',id_login:'forged',image},method:'PUT'},res);
 assert.equal(res.code,200);assert.equal(res.value.data.logoKey,logo.Key);assert.match(res.value.data.logoUrl,/signed.invalid/);

 // Saving contact information must not restore a logo deleted by a concurrent image change.
 let contactSql='';
 dao.get=async()=>({status:200,data:{name:'QA clinic',phone:'5512345678',address:'QA address',logoUrl:logo.Key}});
 db.query=async sql=>{contactSql=sql;return [1];};
 assert.equal((await dao.update('tenant',{name:'Updated clinic',id_login:'actor'})).status,200);
 assert.doesNotMatch(contactSql,/logo_url\s*=/,'Contact update leaves logo ownership to its dedicated route');
 // Actual snapshot consumers receive bytes rather than a key or expiring URL.
 db.query=async(sql,options)=>{
  assert.equal(options.replacements._id_business,'tenant');
  return [{signature_image:signature.Key}];
 };
 for(const [file,method,args] of [
  ['prescription.dao','getDoctor',['doctor','tenant']],
  ['document.dao','getDoctorProfile',['tenant','doctor']]
 ]) {
  const snapshot=await require(path.join(root,'src/Dao/mysql/'+file))[method](...args);
  assert.equal(snapshot.signature_image,image);
 }
 // Real AWS signer, synthetic credentials: signing is local and makes no HTTP call.
 Object.assign(require(path.join(root,'src/config/config')),{AWS_REGION:'us-east-2',AWS_ACCESS_KEY:'synthetic-access-id',AWS_SECRET_KEY:'synthetic-secret'});
 delete require.cache[require.resolve(path.join(root,'src/config/aws/s3'))];
 const adapter=require(path.join(root,'src/config/aws/s3'));
 const url=new URL(await adapter.signGetObject('qa-private',logo.Key,300));
 assert.equal(url.searchParams.get('X-Amz-Algorithm'),'AWS4-HMAC-SHA256');
 assert.equal(url.searchParams.get('X-Amz-Expires'),'300');
 assert.equal(url.searchParams.get('response-cache-control'),'private, no-store');
 assert.match(url.hostname,/s3\.us-east-2\.amazonaws\.com$/);
 console.log('PASS private images: tenant isolation, opaque immutable keys, 300s previews, image validation, durable snapshot bytes, replace/delete ordering, rollback and unknown commit recovery. AWS and SQL mocked.');
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
function stub(file, exports) { const id=require.resolve(path.join(root,file));require.cache[id]={id,filename:id,loaded:true,exports}; }
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
const imageA='data:image/png;base64,'+bytes.toString('base64');
const imageB='data:image/png;base64,'+Buffer.concat([bytes,Buffer.from('B')]).toString('base64');
const keyA='consultorios/tenant/logos/aaaa.png',keyB='consultorios/tenant/logos/bbbb.png';
const objects=new Map([[keyA,bytes],[keyB,Buffer.concat([bytes,Buffer.from('B')])]]);
let logo=keyA, readCount=0, writes=[], commits=0, rollbacks=0, admin=false, rx, history, configExists=true;
const profile={id_login:'doctor',id_doctor_professional_profile:'profile',professional_profile_active:1,professional_name:'QA doctor',professional_license:'QA',signature_image:imageA};
stub('src/config/config.js',{S3_PRIVATE_BUCKET:'synthetic'});
stub('src/config/aws/s3.js',{
 readObject:async(bucket,key)=>{readCount++;if(!objects.has(key))throw Error('Synthetic missing object');return {Body:objects.get(key),ContentType:'image/png'};},
 signGetObject:async()=> 'https://signed.invalid/?expires=300'
});
stub('src/util/professionalContext.js',{resolveProfessional:async()=>({doctor:profile})});
stub('src/util/effectivePermissions.js',{isTenantAdministrator:async(actor,business,permission)=>{assert.equal(business,'tenant');assert.equal(permission,'admin.config');return admin;}});
const db={
 transaction:async()=>({pending:[],async commit(){commits++;for(const fn of this.pending)fn();},async rollback(){rollbacks++;}}),
 query:async(sql,options={})=>{
  const r=options.replacements || {},tx=options.transaction;
  if(sql.startsWith('SELECT logo_url FROM business')){assert.equal(r.business,'tenant');assert.ok(tx);assert.match(sql,/FOR SHARE/);return [{logo_url:logo}];}
  if(sql.includes('SELECT id_prescription FROM prescription'))return [{id_prescription:'rx'}];
  if(sql.startsWith('UPDATE prescription\n')){assert.equal(r._id_business,'tenant');writes.push({sql,r});tx.pending.push(()=>{rx={...rx,status:'issued',issued_by:'doctor',header_image_snapshot:r._header_image,background_image_snapshot:r._background_image,template_snapshot:r._template_snapshot};});return [1];}
  if(sql.startsWith('UPDATE clinical_histories')){assert.equal(r.business || r._business_id,'tenant');writes.push({sql,r});tx.pending.push(()=>{if(r.document_logo)history.document_logo_snapshot_json=r.document_logo;if(r._status)history.status=r._status;});return [1];}
  if(sql.includes('FROM business')){assert.equal(r._id_business,'tenant');return [{id_business:'tenant',name:'QA',...(sql.includes('logo_url')?{logoUrl:logo}:{})}];}
  if(sql.includes('SELECT id_prescription_config'))return configExists?[{id_prescription_config:'config'}]:[];
  if(sql.startsWith('UPDATE prescription_config') || sql.startsWith('INSERT INTO prescription_config')){writes.push({sql,r});return [1];}
  throw Error('Unexpected SQL: '+sql.slice(0,80));
 }
};
stub('src/db/Sequelize.connection.js',db);
const prescriptions=require('../../src/Dao/mysql/prescription.dao');
prescriptions.hasPermission=async()=>true;
prescriptions.getPrescription=async()=>({...rx});
prescriptions.getBusiness=async()=>({active:1,status:'active'});
prescriptions.getItems=async()=>[{generic_name:'QA',dose:'QA',administration_route:'QA',frequency:'QA',duration:'QA'}];
prescriptions.getRawConfig=async()=>({clinic_name:'QA',clinic_address:'QA',clinic_phone:'5511111111',header_image:'old-doctor-header',background_image:'saved-background'});
prescriptions.getDoctor=async()=>profile;
prescriptions.validateDoctorProfileForIssue=()=>({isValid:true});
prescriptions.validateConfigForIssue=()=>({isValid:true});
prescriptions.getPatientIdentity=async()=>({name:'QA',surname:'Patient'});
prescriptions.audit=async()=>{};
prescriptions.getById=async()=>({status:200,data:{...rx}});
prescriptions.getConfig=async()=>({status:200});
const histories=require('../../src/Dao/mysql/clinicalHistory.dao');
histories.validateFinalizer=async()=>({profile});histories.hasPermission=async()=>true;
histories.getDoctorProfile=async()=>profile;
histories.getHistoryById=async()=>({...history});
histories.getPatient=async()=>({id_person:'patient'});
histories.lockDraft=async()=>true;
histories.validateRequiredFieldsFromTemplate=()=>({ok:true});
histories.getSensitiveConsent=async()=>({status:'FIRMADO',token:'qa',document:{id_patient_document:'consent'},signedDocument:{id_patient_document:'consent'}});
histories.getConsentDocumentById=async()=>null;histories.getDoctorForHistory=async()=>profile;histories.addEvent=async()=>{};
histories.hydrate=value=>value;
require('../../src/Dao/mysql/patientAllergy.dao').getCurrent=async()=>({review_status:'NONE_KNOWN',revision:0});
const realDetail=histories.getById.bind(histories);
// Finalization reads in its transaction; model staged changes for its response.
histories.getById=async()=>({status:200,data:{}});
const body={id_business:'tenant',id_login:'doctor',id_prescription:'rx',id_clinical_history:'history',expected_revision:1};
function reset(){writes=[];rx={status:'draft',issuer_doctor_id:'doctor',id_person:'patient'};history={id_clinical_history:'history',patient_id:'patient',status:'DRAFT',revision:1,clinical_snapshot_json:{},template_snapshot_json:{sections:[]}};}
async function issueAndFinalize(){assert.equal((await prescriptions.issue(body)).status,200);assert.equal((await histories.finalize(body)).status,200);return {rx:{...rx},history:{...history}};}
(async()=>{
 reset();const first=await issueAndFinalize();
 assert.equal(first.rx.header_image_snapshot,imageA);assert.equal(first.rx.background_image_snapshot,'saved-background');
 assert.equal(JSON.parse(first.rx.template_snapshot).document_logo,'business_v1');
 assert.equal(JSON.parse(first.history.document_logo_snapshot_json).logo,imageA);
 assert.doesNotMatch(JSON.stringify([first.rx,first.history]),/consultorios\/|signed.invalid/);
 logo=keyB;objects.delete(keyA);reset();const second=await issueAndFinalize();
 assert.equal(second.rx.header_image_snapshot,imageB);assert.equal(JSON.parse(second.history.document_logo_snapshot_json).logo,imageB);
 history=first.history;let reads=readCount;assert.deepEqual((await realDetail(body)).data.document_logo,{state:'captured',image:imageA});assert.equal(readCount,reads,'Finalized documents do not read current logo');
 logo=null;reset();const none=await issueAndFinalize();assert.equal(none.rx.header_image_snapshot,null);
 logo=keyB;history=none.history;assert.deepEqual((await realDetail(body)).data.document_logo,{state:'captured_none',image:null});
 history={...first.history,document_logo_snapshot_json:null};reads=readCount;
 assert.deepEqual((await realDetail(body)).data.document_logo,{state:'unrecorded',image:null});assert.equal(readCount,reads);
 history={...history,status:'DRAFT'};assert.deepEqual((await realDetail(body)).data.document_logo,{state:'current',image:imageB});
 logo=keyA;reset();const before=commits,rolled=rollbacks;
 for(const call of [()=>prescriptions.issue(body),()=>histories.finalize(body)]){const result=await call();assert.equal(result.status,500);assert.match(result.message,/sigue en borrador/);}
 assert.equal(commits,before);assert.equal(rollbacks,rolled+2);assert.equal(writes.length,0);assert.equal(rx.status,'draft');assert.equal(history.status,'DRAFT');
 logo=keyB;reset();await prescriptions.saveConfig({...body,doctor_profile_id:'profile',header_image:'must-be-ignored'});
 assert.doesNotMatch(writes[0].sql,/header_image\s*=/);assert.ok(!Object.hasOwn(writes[0].r,'_header_image'));
 configExists=false;writes=[];await prescriptions.saveConfig({...body,doctor_profile_id:'profile'});assert.match(writes[0].sql,/:_signature_image, NULL, :_background_image/);
 const business=require('../../src/Dao/mysql/business.dao');business.get=async()=>({status:200,data:{id_business:'tenant',logoUrl:null}});
 const controller=require('../../src/controller/mysql/business.controller');
 const res={set(){return this;},status(code){this.code=code;return this;},send(value){this.value=value;}};
 for(const permitted of [false,true]){admin=permitted;await controller.current({tokenDecode:{id_business:'tenant',id_login:'doctor'}},res);assert.equal(res.code,200);assert.equal(res.value.data.canManageLogo,permitted);}
 console.log('PASS shared document logo: real DAOs/controller, mocked transactional SQL and S3; bytes A/B retained, captured absence, legacy, current drafts, fail-closed, unchanged doctor header, server permission.');
})().catch(error=>{console.error(error);process.exitCode=1;});

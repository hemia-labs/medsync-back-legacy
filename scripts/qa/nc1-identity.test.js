'use strict';
const {InstallationError,safeCause}=require('../migrations/nc1-install-error');
const test=require('node:test');const assert=require('node:assert/strict');
const C=require('../../src/domain/identity/contract');const S=require('../../src/domain/identity/storage');const M=require('../migrations/nc1-identity');
test('NC1-R8: generic CURP is exactly the generic literal and requires reason',()=>{
 const value='XXXX999999XXXXXX99';
 assert.throws(()=>C.validate('patient',{curp:{kind:'real',value}}));
 assert.throws(()=>C.validate('patient',{curp:{kind:'generic',value:'AAAA000101HDFBBB09',reason:'fixture'}}));
 assert.throws(()=>C.validate('patient',{curp:{kind:'generic',value}}));
 assert.equal(C.validate('patient',{curp:{kind:'generic',value,reason:'fixture'}}).curp.value,value);
});
test('NC1-R1/R5/R12: civil date normalization and Mexico City day boundary',()=>{
 const {normalizeBirthday}=require('../../src/domain/identity/legacyDate');
 for(const input of ['2000-01-31','31-01-2000','31/01/2000'])assert.equal(normalizeBirthday(input),'2000-01-31');
 for(const input of ['2000/01/31','31/02/2000','bad','01/31/2000','2099-01-01'])assert.throws(()=>normalizeBirthday(input),e=>e.status===400);
 assert.equal(C.today(new Date('2026-11-14T02:00:00Z')),'2026-11-13');
});
test('NC1-R1/R5: route validators accept frontend day-first dates and reject impossible dates',()=>{
 const V=require('../../src/validators/px.validator');
 for(const birthday of ['31-01-2000','31/01/2000','2000-01-31']) {
  const now=new Date(),age=now.getFullYear()-2000-(now.getMonth()===0&&now.getDate()<31?1:0);
  const body={person:{id_person:'qa',name:'Ficticia',surname:'Ensayo',birthday,age,ocupation:'QA',telephone:'5512345678'},address:{id_address:'qa',place_birth:'QA',residence:'QA',direction:'QA',cp:'01000'},query:{id_query:'qa',reason_consultation:'QA',current_condition:'QA'},allergy:{review_status:'UNREVIEWED'},identity:{biologicalSex:'2'}};
  assert.equal(V.validatePxUpdate({body}).isValid,true);
  assert.equal(V.validatePxSave({body}).isValid,true);
  body.person.birthday='31-02-2000';assert.equal(V.validatePxUpdate({body}).isValid,false);
 }
});
test('new patients require explicit biological sex, not gender/legacy sex',()=>{for(const patch of [{},{genderIdentity:'1'},{biologicalSex:true},{biologicalSex:'0'}])assert.throws(()=>C.validate('patient',patch,{}, {creating:true}));for(const biologicalSex of ['1','2','3'])assert.equal(C.validate('patient',{biologicalSex},{},{creating:true}).biologicalSex,biologicalSex);});
test('CR4 enumerations retain nonresponses and migration type',()=>{assert.throws(()=>C.validate('patient',{migrantStatus:true}));assert.equal(C.validate('patient',{migrantStatus:'returned',indigenousSelfIdentification:'declined'}).migrantStatus,'returned');});
test('candidate/ref strict shape, sentinel rejection and exact codes',()=>{C.reference({family:'sis.country',code:'001'},'sis.country','birthCountry');assert.throws(()=>C.reference({family:'sis.country',code:'01',releaseId:null},'sis.country','birthCountry'));assert.throws(()=>C.reference({family:'sis.federal_entity',code:'88'},'sis.federal_entity','birthEntity'));});
test('PATCH absent/null and residence hierarchy',()=>{const cur={biologicalSex:'2',migrantStatus:'national',residence:{entity:{family:'inegi.state',code:'01'}}};assert.equal(C.validate('patient',{migrantStatus:null},cur).biologicalSex,'2');assert.throws(()=>C.validate('patient',{residence:{municipality:{family:'inegi.municipality',code:'02001'}}},cur));});
test('no heuristic surnames or CURP sex and all catalogs remain unverified',()=>{const d=C.legacy({name:'Ficticia',surname:'De la Prueba Ensayo',birthday:'2000-01-01'});assert.equal(d.firstSurname,null);assert.equal(d.legacySurname,'De la Prueba Ensayo');const v=C.view({...d,birthCountry:{family:'sis.country',code:'142'},curp:{value:'XXXXXXXXXXXXXXXXXX',kind:'generic',reason:'fixture'}},1);assert.equal(v.curpSex,null);assert.equal(v.curp.validationStatus,'unchecked');assert.equal(v.qualityIssues[0].code,'CATALOG_UNAVAILABLE');});
test('storage round trip and no catalog FK',()=>{const d={...C.validate('patient',{biologicalSex:'3',birthCountry:{family:'sis.country',code:'001'},residence:{entity:{family:'inegi.state',code:'01'}}}),legacySurname:'Raw'};const round=S.decode('patient',S.encode('patient',d));assert.deepEqual(round.birthCountry,d.birthCountry);assert.deepEqual(round.residence.entity,d.residence.entity);assert.ok(M.statements.every(sql=>!sql.includes('REFERENCES sis_catalog')));});
test('date and readonly rejection',()=>{assert.throws(()=>C.validate('patient',{birthDate:'2026-02-30'}));assert.throws(()=>C.validate('patient',{revision:42}));assert.throws(()=>C.validate('establishment',{displayName:'Test',validFrom:'2026-01-02',validTo:'2026-01-01'}));});

test('NC1 R17: safe installer causes omit driver messages, SQL, host and credentials',()=>{
 assert.deepEqual(safeCause(new InstallationError('NC1 parent incompatible: person')),{message:'NC1 parent incompatible: person'});
 const driver=Object.assign(new Error('SECRET host/user SQL'),{code:'ER_ACCESS_DENIED_ERROR',sqlState:'28000',sql:'SECRET SQL',password:'SECRET'});
 assert.deepEqual(safeCause(driver),{code:'ER_ACCESS_DENIED_ERROR',sqlState:'28000'});
 assert.doesNotMatch(JSON.stringify(safeCause(new Error('SECRET'))),/SECRET/);
 assert.doesNotMatch(JSON.stringify(safeCause({code:'ER_BAD\nSECRET',sqlState:'SECRET'})),/SECRET/);
});
test('NC1 R17: CLI checksum rejection is actionable, sanitized and exits 1 without configuration',()=>{
 const {spawnSync}=require('node:child_process');
 const result=spawnSync(process.execPath,[require.resolve('../migrations/install-nc1-identity'),'apply','synthetic_fixture','wrongchecksum','synthetic-operator'],{encoding:'utf8'});
 assert.equal(result.status,1);const failure=JSON.parse(result.stderr.trim());
 assert.equal(failure.event,'nc1.install.failed');assert.match(failure.message,/checksum does not match/);
 assert.equal(result.stdout,'');assert.doesNotMatch(result.stderr,/wrongchecksum|synthetic_fixture|synthetic-operator/);
});

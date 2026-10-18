'use strict';
const assert = require('node:assert/strict');
const {validateConfigSave} = require('../../src/validators/prescription.validator');
const payload = overrides => ({clinic_phone:'55 1234 5678',clinic_address:'Calle de prueba 10',template_mode:'header',background_opacity:0.1,...overrides});
for(const clinic_phone of ['ABC','   ','123','1234567890123456','55abc12345678',1000000000]) {
    assert.equal(validateConfigSave({body:payload({clinic_phone})}).isValid,false,'Invalid phone must fail: '+clinic_phone);
}
for(const clinic_phone of ['5512345678','+52 (55) 1234-5678','001234567890123']) assert.equal(validateConfigSave({body:payload({clinic_phone})}).isValid,true);
for(const clinic_address of ['', '   ', null, 123, 'x'.repeat(2001)]) assert.equal(validateConfigSave({body:payload({clinic_address})}).isValid,false);
const normalized=payload({clinic_phone:'  5512345678  ',clinic_address:'  Domicilio de prueba  '});
assert.equal(validateConfigSave({body:normalized}).isValid,true);
assert.equal(normalized.clinic_phone,'5512345678'); assert.equal(normalized.clinic_address,'Domicilio de prueba');
for(const background_opacity of [-0.1,1.1,NaN,'',null,false,[]]) assert.equal(validateConfigSave({body:payload({background_opacity})}).isValid,false);
assert.equal(validateConfigSave({body:payload({background_opacity:0})}).isValid,true);
assert.equal(validateConfigSave({body:payload({background_opacity:1})}).isValid,true);
assert.equal(validateConfigSave({body:payload({template_mode:'unknown'})}).isValid,false);
console.log('PASS UX12 recipe config validation: required meaningful address, 10–15 phone digits and formatting, normalization, opacity boundaries and allowed modes.');

function stub(modulePath,exports) {const id=require.resolve(modulePath);require.cache[id]={id,filename:id,loaded:true,exports};}
stub('../../src/db/Sequelize.connection',{query(){throw Error('Unexpected database query');}});
stub('../../src/util/effectivePermissions',{});
const dao=require('../../src/Dao/mysql/clinicalHistoryTemplate.dao');
const {baseClinicalHistoryTemplate}=require('../../src/domain/clinicalHistory/clinicalHistoryBaseTemplate');
const schema=()=>JSON.parse(JSON.stringify(baseClinicalHistoryTemplate));
assert.equal(dao.validateSchema(schema()).ok,true,'Existing base schema remains compatible');
for(const order of [-1,0,1.5,null,'',true,Infinity,1000]) {
    const bad=schema();bad.sections[0].order=order;
    assert.equal(dao.validateSchema(bad).ok,false,'Invalid section position must fail: '+order);
}
const duplicate=schema();duplicate.sections[1].order=duplicate.sections[0].order;
assert.equal(dao.validateSchema(duplicate).ok,false);
const reordered=schema();[reordered.sections[0].order,reordered.sections[1].order]=[2,1];
assert.equal(dao.validateSchema(reordered).ok,true,'A unique positive reorder is valid');
const allergy=schema();allergy.sections.find(section=>section.key==='allergies_medications').enabled=false;
assert.equal(dao.validateSchema(allergy).ok,false,'Allergy requirements remain protected');
console.log('PASS UX12 clinical template schema: positive integer unique positions, valid reordering, base compatibility and protected allergy core. No HTTP or database.');

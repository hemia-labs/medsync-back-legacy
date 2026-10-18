'use strict';
const assert = require('node:assert/strict');
const { validateBusinessProfile, validateBusinessUpdatePayload } = require('../../src/validators/business.validator');
const base = { name: ' Consultorio QA ', phone: '+52 (012) 345-6789', address: ' Domicilio QA ', email: ' contacto@example.test ', logoUrl: ' https://example.test/logo.png ', legalName: ' Razón QA ' };
const normalized = validateBusinessProfile(base);
assert.equal(normalized.isValid, true);
assert.deepEqual(normalized.data, { name:'Consultorio QA',legalName:'Razón QA',email:'contacto@example.test',phone:'0123456789',address:'Domicilio QA',logoUrl:'https://example.test/logo.png' });
for(const invalid of [
    { phone: 'abc123' }, { phone: 1234567890 }, { phone:'12345' }, { phone:'+1 0123456789' },
    { name:'  ' }, { address:' \n\t ' }, { email:'correo-sin-arroba' }, { email:{} },
    { logoUrl:'javascript:alert(1)' }, { logoUrl:'data:image/png;base64,AAAA' }, { logoUrl:'https://user:pass@example.test/logo' },
    { logoUrl:'https://example.test/logo con espacio.png' }, { logoUrl:'//example.test/logo.png' }, { address:'x'.repeat(1001) }
]) assert.equal(validateBusinessProfile({ ...base, ...invalid }).isValid, false, JSON.stringify(invalid));
assert.equal(validateBusinessProfile({ ...base, email:null, logoUrl:'', legalName:null }).isValid, true);
assert.equal(validateBusinessProfile({ name:' Nuevo nombre ' }, { partial:true }).data.name, 'Nuevo nombre');
assert.equal(Object.keys(validateBusinessProfile({ name:'Nuevo nombre' }, { partial:true }).data).length, 1, 'Omitted fields never become destructive defaults');
let next = false, response = null, status = null;
const res = { status(value) {status=value;return this;},send(value) {response=value;return this;} };
validateBusinessUpdatePayload({ body:{ phone:'abc123', email:'correo-sin-arroba' } }, res, () => { next=true; });
assert.equal(next, false); assert.equal(status, 400); assert.ok(response.data.fieldErrors.phone); assert.ok(response.data.fieldErrors.email);
assert.doesNotMatch(JSON.stringify(response), /abc123|correo-sin-arroba/, 'The error DTO never echoes submitted values');
const req = { body:base }; validateBusinessUpdatePayload(req,res,()=>{next=true;}); assert.equal(next,true); assert.equal(req.body.phone,'0123456789');

function stub(modulePath, exports) { const id=require.resolve(modulePath);require.cache[id]={id,filename:id,loaded:true,exports}; }
let updates = 0, latest = null, noCurrent = false;
let current = { id_business:'qa-tenant',name:'Original',legalName:'Razón conservada',email:'original@example.test',phone:'0123456789',address:'Domicilio original',logoUrl:'https://example.test/original.png' };
stub('../../src/db/Sequelize.connection', { async query(sql, options) {
    assert.equal(options.replacements._id_business, 'qa-tenant');
    if(/^SELECT/.test(sql.trim())) return noCurrent ? [] : [current];
    assert.match(sql, /^UPDATE business/); updates++; latest=options.replacements; return [1];
} });
stub('../../src/util/effectivePermissions', {});
const dao = require('../../src/Dao/mysql/business.dao');
(async () => {
    const valid = await dao.update('qa-tenant', { name:' Cambio ',phone:'+52 (012) 345-6789',id_login:'qa-actor',id_business:'foreign' });
    assert.equal(valid.status,200); assert.equal(updates,1); assert.equal(latest._name,'Cambio'); assert.equal(latest._phone,'0123456789');
    assert.equal(latest._legal_name,current.legalName); assert.equal(latest._email,current.email); assert.equal(latest._logo_url,current.logoUrl); assert.equal(latest._updated_by,'qa-actor');
    const invalid = await dao.update('qa-tenant', {phone:'abc123'}); assert.equal(invalid.status,400); assert.ok(invalid.data.fieldErrors.phone); assert.equal(updates,1);
    noCurrent=true; const unavailable=await dao.update('qa-tenant',base);assert.equal(unavailable.status,500);assert.equal(updates,1,'A missing/failed current read cannot erase fields');
    console.log('PASS UX12 business: trim, Mexican phone formats/leading zeros, optional email and safe logo URLs, minimal field errors, authoritative DAO validation, partial field retention, token-scoped WHERE and blocked write after unreadable current data. Mock SQL only; no DB.');
})().catch(error=>{console.error(error);process.exitCode=1;});

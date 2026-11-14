'use strict';
const C = require('./contract');
const common = { givenNames:'VARCHAR(500)',firstSurname:'VARCHAR(500)',secondSurname:'VARCHAR(500)',firstSurnameStatus:'VARCHAR(20)',secondSurnameStatus:'VARCHAR(20)',birthDate:'DATE',curp:'JSON' };
const models = {
    patient: { table:'patient_identity',key:'id_person',scalars:{...common,legacySurname:'VARCHAR(500)',biologicalSex:'VARCHAR(1)',genderIdentity:'VARCHAR(2)',indigenousSelfIdentification:'VARCHAR(24)',afromexicanSelfIdentification:'VARCHAR(24)',migrantStatus:'VARCHAR(20)',residenceAddressText:'VARCHAR(1000)'},refs:{...C.refs,...Object.fromEntries(Object.entries(C.residenceRefs).map(([k,v])=>['residence'+k[0].toUpperCase()+k.slice(1),v]))},list:'affiliations',listTable:'patient_identity_affiliation',listFamily:'sis.affiliation' },
    professional: {table:'professional_identity',key:'id_doctor_professional_profile',scalars:{...common,legacyProfessionalName:'VARCHAR(250)'},refs:{birthCountry:'sis.country'},list:'authorizedPersonnelTypes',listTable:'professional_identity_personnel_type',listFamily:'sis.personnel_type'},
    establishment: {table:'care_establishment',key:'id_care_establishment',scalars:{displayName:'VARCHAR(250)',active:'BOOLEAN',validFrom:'DATE',validTo:'DATE'},refs:{cluesRef:'sis.establishments'}}
};
const prefix = k => k === 'cluesRef' ? 'clues' : C.snake(k);
function flatten(data) { const o={...data}; if(data.residence) for(const [k,v] of Object.entries(data.residence)) o['residence'+k[0].toUpperCase()+k.slice(1)]=v; return o; }
function encode(kind,data) {
    const m=models[kind],d=flatten(data),row={};
    for(const [k,type] of Object.entries(m.scalars)) row[C.snake(k)]=d[k]==null?null:type==='JSON'?JSON.stringify(d[k]):d[k];
    for(const k of Object.keys(m.refs)) { const r=d[k],p=prefix(k); row[p+'_family']=r?r.family:null;row[p+'_release_id']=r&&r.releaseId||null;row[p+'_code']=r?r.code:null; }
    return row;
}
function decode(kind,row,list=[]) {
    const m=models[kind],d={};
    const set=(k,v)=>{ if(k.startsWith('residence')) { const key=k.slice(9);d.residence=d.residence||{};d.residence[key[0].toLowerCase()+key.slice(1)]=v; } else d[k]=v; };
    for(const [k,type] of Object.entries(m.scalars)) { let v=row[C.snake(k)];if(type==='JSON'&&typeof v==='string')v=JSON.parse(v);if(type==='BOOLEAN')v=!!v;set(k,v==null?null:v); }
    for(const k of Object.keys(m.refs)) {const p=prefix(k);set(k,row[p+'_code']==null?null:{family:row[p+'_family'],code:row[p+'_code'],...(row[p+'_release_id']?{releaseId:row[p+'_release_id']}:{})});}
    if(m.list)d[m.list]=list.length?list.map(r=>({family:r.family,code:r.code,...(r.release_id?{releaseId:r.release_id}:{})})):null;
    return d;
}
module.exports={models,prefix,encode,decode};

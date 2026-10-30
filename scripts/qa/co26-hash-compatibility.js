'use strict';
const assert=require('node:assert/strict');
const {createHash,createHmac}=require('node:crypto');
const connection=require.resolve('../../src/db/Sequelize.connection');require.cache[connection]={id:connection,filename:connection,loaded:true,exports:{}};
process.env.SESSION_SECRET='CO26 synthetic legacy fingerprint regression key';
const documents=require('../../src/services/documentSignature/treatmentPlanConsentDocument.service');
const TreatmentPlanDao=require('../../src/Dao/mysql/treatmentPlan.dao');
const dao=new TreatmentPlanDao();
const plan={title:'Plan legacy',diagnosis:null,notes:'Nota interna',started_at:'2026-10-01',treatments:[{id_patient_treatment:'one',name:'Tratamiento',description:null,category:'General',status:'pending',cost:'125.00',estimated_start_date:'2026-10-02',estimated_end_date:null,notes:'Manual',teeth:['55','16']}]};
// Frozen legacy projections: deliberately independent of contentProjection.
const legacyDocument={title:'Plan legacy',diagnosis:'',notes:'Nota interna',started_at:'2026-10-01',treatments:[{id:'one',name:'Tratamiento',description:'',category:'General',status:'pending',cost:'125',start:'2026-10-02',end:null,notes:'Manual',teeth:['16','55']}]};
const legacyReview={title:'Plan legacy',diagnosis:null,notes:'Nota interna',started_at:'2026-10-01',treatments:[{id:'one',name:'Tratamiento',description:null,category:'General',status:'pending',cost:'125.00',start:'2026-10-02',end:null,notes:'Manual',teeth:['55','16']}]};
assert.equal(documents.fingerprint(plan),createHash('sha256').update(JSON.stringify(legacyDocument)).digest('hex'));
assert.equal(dao.reviewToken(plan),createHmac('sha256',process.env.SESSION_SECRET).update(JSON.stringify(legacyReview)).digest('hex'));
const enriched=JSON.parse(JSON.stringify(plan));enriched.treatments[0].tooth_details=[{tooth_number:'55',surfaces:null,manual:true,sources:[{id_chart:'chart',revision:2}]}];
assert.equal(documents.fingerprint(enriched),documents.fingerprint(plan));assert.equal(dao.reviewToken(enriched),dao.reviewToken(plan));
enriched.treatments[0].tooth_details[0].surfaces='MO';assert.notEqual(documents.fingerprint(enriched),documents.fingerprint(plan));assert.notEqual(dao.reviewToken(enriched),dao.reviewToken(plan));
const facesHash=documents.fingerprint(enriched);enriched.treatments[0].tooth_details[0].sources[0].revision=3;assert.equal(documents.fingerprint(enriched),facesHash);
console.log('PASS frozen legacy document/review hash projections, no-face provenance enrichment, explicit face invalidation and source-only stability. No DB/signature writes.');

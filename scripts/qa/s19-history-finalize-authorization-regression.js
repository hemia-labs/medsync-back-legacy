'use strict';
const assert = require('node:assert/strict');
const path = require.resolve('../../src/db/Sequelize.connection');
let rolledBack = 0, reads = 0, authorized = false;
require.cache[path] = { id:path,filename:path,loaded:true,exports:{
    async transaction() { return { async commit(){},async rollback(){rolledBack++;} }; },
    async query() { throw new Error('Unauthorized finalization must not query clinical SQL'); }
} };
const dao = require('../../src/Dao/mysql/clinicalHistory.dao');
dao.hasPermission = async () => authorized;
dao.getDoctorProfile = async () => ({ id_login:'qa-doctor',id_doctor_professional_profile:'qa-profile',professional_profile_active:1,
    professional_name:'QA doctor',professional_license:'QA license',rol:'doctor' });
dao.getHistoryById = async id => { reads++; return id === 'missing' ? null : {status:id==='draft'?'DRAFT':'FINALIZED'}; };
(async()=>{
    for(const id of ['draft','finalized','missing']) {
        assert.equal((await dao.finalize({id_business:'qa-business',id_login:'qa-reception',id_clinical_history:id})).status,403);
    }
    assert.equal(reads,0);assert.equal(rolledBack,3);
    authorized=true;
    assert.equal((await dao.finalize({id_business:'qa-business',id_login:'qa-doctor',id_clinical_history:'finalized'})).status,409);
    assert.equal(reads,1,'Authorized doctor retains the existing state conflict');
    console.log('PASS S19 clinical finalize: denied actors see neither existence, status nor revision for draft/finalized/missing; allowed professional keeps state conflict. Real DAO, simulated authorization/data; no DB.');
})().catch(error=>{console.error(error);process.exitCode=1;});

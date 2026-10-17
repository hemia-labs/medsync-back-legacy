const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const config=require('../../src/config/config');
const mysql=require('mysql2/promise');
const {QueryTypes}=require('sequelize');
let connection;
// Run the DAO's SQL through one live QA connection, without Sequelize's version probe connection.
const db={
    async query(sql,options) {
        const parameters=Object.fromEntries(Object.entries(options.replacements||{}).map(([key,value])=>['param'+key,value]));
        const statement=sql.replace(/:([A-Za-z_]\w*)/g,(_match,key)=>':param'+key);
        try {const [rows]=await connection.query(statement,parameters);return rows;}
        catch(error) {console.error('Live QA SQL error:',error.code,String(error.sqlMessage||'').replace(/'[^']*'/g,"'[redacted]'"));throw error;}
    },
    async transaction() { await connection.beginTransaction();return {commit:()=>connection.commit(),rollback:()=>connection.rollback()}; }
};
const connectionPath=require.resolve('../../src/db/Sequelize.connection');
require.cache[connectionPath]={id:connectionPath,filename:connectionPath,loaded:true,exports:db};
const dao=require('../../src/Dao/mysql/prescription.dao');
const actor={id_business:'QA_BUSINESS_CLINICAL',id_login:'QA_LOGIN_CLINICAL'};
const ids=['QAC_RX_017','QAC_RX_019','QAC_RX_008'];
const read=sql=>db.query(sql,{replacements:{tenant:actor.id_business,ids},type:QueryTypes.SELECT});
(async()=>{
    connection=await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL,namedPlaceholders:true});
    const snapshot=()=>read('SELECT p.id_prescription,p.status,p.cancelled_at,p.cancellation_reason,COUNT(i.id_prescription_item) AS item_count FROM prescription p LEFT JOIN prescription_item i ON i.id_prescription=p.id_prescription AND i.id_business=p.id_business WHERE p.id_business=:tenant AND p.id_prescription IN (:ids) GROUP BY p.id_prescription,p.status,p.cancelled_at,p.cancellation_reason ORDER BY p.id_prescription');
    const auditCounts=()=>read("SELECT id_prescription,COUNT(*) AS total FROM prescription_audit_log WHERE id_business=:tenant AND id_prescription IN (:ids) AND action IN ('printed','downloaded','pdf_generated') GROUP BY id_prescription ORDER BY id_prescription");
    const before=await snapshot(), beforeAudits=await auditCounts();
    const checks=[];
    for(const id of ids.slice(0,2)) for(const action of ['printed','downloaded']) {
        const r=await dao.prepareOutput({...actor,id_prescription:id,action,metadata:{source:'cd10_qa_output_authorization'}});
        assert.equal(r.status,400); assert.equal(r.data.prescription,undefined);checks.push({id,status:r.data.status,action,httpStatus:r.status});
    }
    const issued=await dao.prepareOutput({...actor,id_prescription:'QAC_RX_008',action:'pdf_generated',metadata:{source:'cd10_qa_output_authorization'}});
    assert.equal(issued.status,200);assert.equal(issued.data.prescription.status,'issued');assert.ok(issued.data.prescription.items.length>0);
    checks.push({id:'QAC_RX_008',status:'issued',action:'pdf_generated',httpStatus:200});
    assert.deepEqual(await snapshot(),before,'Clinical records must stay unchanged');
    const afterAudits=await auditCounts();
    const count=(rows,id)=>Number((rows.find(row=>row.id_prescription===id)||{}).total||0);
    for(const id of ids) assert.equal(count(afterAudits,id)-count(beforeAudits,id),id==='QAC_RX_008'?1:0);
    const evidence=path.resolve(__dirname,'../../../docs/clinical-documents/phases/evidence/cd10-prescription-output');
    await fs.mkdir(evidence,{recursive:true});
    await fs.writeFile(path.join(evidence,'live-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,clinicalRecordsUnchanged:true,authorizedOutputAuditAdded:1,blockedOutputAuditsAdded:0,connectionCount:1,printedOrSavedPdf:false},null,2));
    console.log('PASS live prescription output: draft/cancelled denied, issued authorized; one QA audit, no clinical record changes, no physical print/PDF saved; one connection.');
})().catch(error=>{console.error('CD10 live QA failed:',error.message.slice(0,160),error.stack.split('\n').find(line=>line.includes('prescription-output-live-verification.js:')));process.exitCode=1;}).finally(()=>connection&&connection.end());

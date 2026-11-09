'use strict';
const mysql=require('mysql2/promise');
const columns={legal_evidence_payload:'JSON NULL',legal_evidence_id:'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL',
    legal_attempts:'INT UNSIGNED NOT NULL DEFAULT 0',legal_retry_at:'DATETIME(3) NULL',legal_lease_id:'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL',
    legal_lease_until:'DATETIME(3) NULL',legal_error_code:'VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NULL'};
async function apply(db,write=false) {
    const [tables]=await db.query("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registration_outbox'");
    if(tables.length!==1||tables[0].ENGINE!=='InnoDB')throw Error('S26_REGISTRATION_OUTBOX_REQUIRED');
    const [rows]=await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registration_outbox'");
    const missing=Object.keys(columns).filter(name=>!rows.some(r=>r.COLUMN_NAME===name));
    if(missing.length&&missing.length!==Object.keys(columns).length)throw Error('S26_PARTIAL_SCHEMA_REQUIRES_REVIEW');
    if(write&&missing.length)await db.query('ALTER TABLE registration_outbox '+missing.map(name=>'ADD COLUMN '+name+' '+columns[name]).join(', '));
    return {migration:'S26 registration Legal evidence',alreadyApplied:!missing.length,applied:write&&missing.length>0,missingColumns:write?[]:missing};
}
async function main(){const config=require('../../src/config/config');const write=process.argv.includes('--apply');
    if(write&&process.env.APP_ENV!=='development')throw Error('S26_DEVELOPMENT_TARGET_REQUIRED');
    const db=await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL});
    try{console.log(JSON.stringify(await apply(db,write)));}finally{await db.end();}}
if(require.main===module)main().catch(e=>{console.error(e.code||(/^S26_/.test(e.message)?e.message:'S26_MIGRATION_FAILED'));process.exitCode=1;});
module.exports={apply,columns};

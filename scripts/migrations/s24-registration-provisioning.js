'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const mysql=require('mysql2/promise');

async function preflight(db) {
    const required=['auth_identity','registration_attempt','saas_legal_documents','saas_legal_versions','saas_legal_acceptances','admin_audit_log'];
    const [tables]=await db.query('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)',[[...required,'registration_outbox']]);
    const guards=['s24_login_insert','s24_login_update','saas_legal_versions_no_update','saas_legal_versions_no_delete','saas_legal_acceptances_no_update','saas_legal_acceptances_no_delete'];
    const [triggers]=await db.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN (?)',[guards]);
    const missing=required.filter(name=>!tables.some(t=>t.TABLE_NAME===name&&t.ENGINE==='InnoDB'));
    const missingGuards=guards.filter(name=>!triggers.some(t=>t.TRIGGER_NAME===name));
    const alreadyPresent=tables.some(t=>t.TABLE_NAME==='registration_outbox');
    return {checkedAt:new Date().toISOString(),readOnly:true,missing,missingGuards,alreadyPresent,ready:!missing.length&&!missingGuards.length&&!alreadyPresent};
}
async function main() {
    const config=require('../../src/config/config'),args=process.argv.slice(2),apply=args.includes('--apply');
    if(apply && (!args.includes('--writers-stopped')||!args.includes('--expect-database')||args[args.indexOf('--expect-database')+1]!==config.DATABASEMYSQL))
        throw Error('S24B_EXACT_TARGET_AND_STOPPED_WRITERS_REQUIRED');
    const db=await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL});
    try {
        const report=await preflight(db);console.log(JSON.stringify(report,null,2));
        if(!apply)return;
        if(!report.ready)throw Error('S24B_PREFLIGHT_FAILED');
        const backup=path.resolve(__dirname,'../../../_schema_backups','s24b-'+new Date().toISOString().replace(/[:.]/g,'-'));
        await fs.mkdir(backup,{recursive:true});
        await fs.writeFile(path.join(backup,'preflight.json'),JSON.stringify(report,null,2));
        const sql=await fs.readFile(path.join(__dirname,'s24-registration-provisioning.sql'),'utf8');
        await fs.writeFile(path.join(backup,'planned-addition.sql'),sql);
        await db.query(sql);console.log('S24B additive outbox created; no public route enabled.');
    } finally {await db.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.code || (/^S24B_/.test(error.message)?error.message:'S24B_MIGRATION_FAILED'));process.exitCode=1;});
module.exports={preflight};

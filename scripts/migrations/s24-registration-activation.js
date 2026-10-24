'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),mysql=require('mysql2/promise');
const {statements,backfill}=require('./s24ActivationSchema');
async function preflight(db) {
    const [rows]=await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('registration_account','registration_contact_challenge','auth_identity','admin_audit_log')");
    const names=rows.map(row=>row.TABLE_NAME);
    return {readOnly:true,alreadyPresent:names.includes('registration_account'),ready:['registration_contact_challenge','auth_identity','admin_audit_log'].every(name=>names.includes(name))};
}
async function main() {
    const config=require('../../src/config/config'),args=process.argv.slice(2),apply=args.includes('--apply');
    if(apply&&(!args.includes('--writers-stopped')||!args.includes('--expect-database')||args[args.indexOf('--expect-database')+1]!==config.DATABASEMYSQL))
        throw Error('S24R4_EXACT_TARGET_AND_STOPPED_WRITERS_REQUIRED');
    const db=await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL});
    try {
        const report=await preflight(db);console.log(JSON.stringify(report));if(!apply)return;
        if(!report.ready)throw Error('S24R4_PREFLIGHT_FAILED');
        const backup=path.resolve(__dirname,'../../../_schema_backups','s24r4-'+new Date().toISOString().replace(/[:.]/g,'-'));
        await fs.mkdir(backup,{recursive:true});
        await fs.writeFile(path.join(backup,'preflight.json'),JSON.stringify(report,null,2));
        await fs.writeFile(path.join(backup,'planned-addition.sql'),[...statements,backfill].join(';\n')+';\n');
        if(!report.alreadyPresent)for(const sql of statements)await db.query(sql);
        await db.beginTransaction();
        try {await db.query(backfill);await db.commit();}catch(error){await db.rollback();throw error;}
        console.log('S24R4 schema applied; flags and license states unchanged.');
    } finally{await db.end();}
}
if(require.main===module)main().catch(error=>{console.error(/^S24R4_/.test(error.message)?error.message:'S24R4_MIGRATION_FAILED');process.exitCode=1;});
module.exports={preflight};

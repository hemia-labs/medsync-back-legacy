'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),mysql=require('mysql2/promise');
const {statements}=require('./s24ContactSchema');
async function preflight(db) {
    const base=await require('./s24-registration-provisioning').preflight(db);
    const [tables]=await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('registration_rate_bucket','registration_contact_challenge')");
    const [checks]=await db.query("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_s24_identity_state'");
    const reserved=Boolean(checks[0]?.CHECK_CLAUSE.includes('reserved'));
    return {readOnly:true,checkedAt:new Date().toISOString(),missing:base.missing,missingGuards:base.missingGuards,
        outboxPresent:base.alreadyPresent,contactTables:tables.map(t=>t.TABLE_NAME),reservedState:reserved,
        ready:!base.missing.length&&!base.missingGuards.length&&base.alreadyPresent&&!tables.length&&!reserved};
}
async function main() {
    const config=require('../../src/config/config'),args=process.argv.slice(2),apply=args.includes('--apply');
    if(apply&&(!args.includes('--writers-stopped')||!args.includes('--expect-database')||args[args.indexOf('--expect-database')+1]!==config.DATABASEMYSQL))
        throw Error('S24C_EXACT_TARGET_AND_STOPPED_WRITERS_REQUIRED');
    const db=await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL});
    try {
        const report=await preflight(db);console.log(JSON.stringify(report,null,2));if(!apply)return;
        if(!report.ready)throw Error('S24C_PREFLIGHT_FAILED');
        const backup=path.resolve(__dirname,'../../../_schema_backups','s24c-'+new Date().toISOString().replace(/[:.]/g,'-'));
        await fs.mkdir(backup,{recursive:true});
        const [rows]=await db.query('SHOW CREATE TABLE auth_identity');
        await fs.writeFile(path.join(backup,'auth_identity-before.sql'),rows[0]['Create Table']);
        await fs.writeFile(path.join(backup,'preflight.json'),JSON.stringify(report,null,2));
        await fs.writeFile(path.join(backup,'planned-addition.sql'),statements.join(';\n')+';\n');
        for(const sql of statements)await db.query(sql);
        console.log('S24C schema applied; registration and delivery flags unchanged.');
    } finally{await db.end();}
}
if(require.main===module)main().catch(error=>{console.error(/^S24C_/.test(error.message)?error.message:'S24C_MIGRATION_FAILED');process.exitCode=1;});
module.exports={preflight};

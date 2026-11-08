'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');

function trigger(event) {
    return `CREATE TRIGGER s24_login_${event.toLowerCase()} AFTER ${event} ON login FOR EACH ROW
    BEGIN
        DECLARE pending_account TINYINT DEFAULT 0;
        DECLARE contact_only_phone TINYINT DEFAULT 0;
        SELECT COALESCE(MAX(subscription_status='pending_activation'),0) INTO pending_account
            FROM business WHERE id_business=NEW.id_business;
        SET contact_only_phone = EXISTS(SELECT 1 FROM registration_account a
            WHERE a.id_login=NEW.id_login AND a.id_business=NEW.id_business)
            OR (pending_account=1 AND COALESCE(NEW.created_by=NEW.id_login,0) AND EXISTS(
                SELECT 1 FROM business b WHERE b.id_business=NEW.id_business AND b.created_by=NEW.id_login));
        IF contact_only_phone=0 AND NULLIF(TRIM(NEW.telephone),'') IS NOT NULL THEN
            CALL s24_claim_identity('phone',s24_phone(NEW.telephone),NEW.id_login,pending_account);
        END IF;
        CALL s24_claim_identity('email',s24_email(NEW.email),NEW.id_login,pending_account);
    END`;
}
const triggers={s24_login_insert:trigger('INSERT'),s24_login_update:trigger('UPDATE')};
const unverified=`FROM auth_identity i JOIN registration_account a ON a.id_login=i.id_login
    JOIN login l ON l.id_login=a.id_login AND l.id_business=a.id_business
    JOIN business b ON b.id_business=a.id_business
    WHERE i.kind='phone' AND i.reservation_status IN ('pending','reserved','legacy') AND i.verified_at IS NULL
        AND l.created_by=l.id_login AND b.created_by=l.id_login`;
async function audit(db) {
    const [rows]=await db.query("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('s24_login_insert','s24_login_update')");
    if(rows.length!==2) throw Error('S27_IDENTITY_TRIGGERS_REQUIRED');
    const [[counts]]=await db.query('SELECT COUNT(*) n '+unverified);
    return {alreadyApplied:rows.every(row=>row.ACTION_STATEMENT.includes('contact_only_phone'))&&Number(counts.n)===0,
        unverifiedPhoneIdentities:Number(counts.n)};
}
async function apply(db,backupDirectory) {
    const before=await audit(db);
    if(before.alreadyApplied)return before;
    const originals={};
    for(const name of Object.keys(triggers)) {
        const [[row]]=await db.query('SHOW CREATE TRIGGER `'+name+'`');
        originals[name]=row['SQL Original Statement'];
    }
    await fs.mkdir(backupDirectory,{recursive:true});
    await fs.writeFile(path.join(backupDirectory,'phone-identity-triggers.json'),JSON.stringify(originals,null,2),{flag:'wx',mode:0o600});
    // DDL commits implicitly; all writers must remain stopped until cleanup commits.
    for(const [name,sql] of Object.entries(triggers)) {
        await db.query('DROP TRIGGER `'+name+'`');
        try {await db.query(sql);} catch(error) {await db.query(originals[name]);throw error;}
    }
    await db.beginTransaction();
    try {await db.query('DELETE i '+unverified);await db.commit();}
    catch(error){await db.rollback();throw error;}
    return {...await audit(db),releasedPhoneIdentities:before.unverifiedPhoneIdentities};
}
async function main() {
    const config=require('../../src/config/config'),args=process.argv.slice(2),write=args.includes('--apply');
    if(write&&(!args.includes('--writers-stopped')||!args.includes('--expect-database')
        ||args[args.indexOf('--expect-database')+1]!==config.DATABASEMYSQL)) throw Error('S27_EXACT_TARGET_AND_STOPPED_WRITERS_REQUIRED');
    const db=await require('mysql2/promise').createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL});
    try {console.log(JSON.stringify(write?await apply(db,path.resolve(__dirname,'../../.schema-backups/s27-'+Date.now())):await audit(db)));}
    finally {await db.end();}
}
if(require.main===module)main().catch(error=>{console.error(/^S27_/.test(error.message)?error.message:'S27_MIGRATION_FAILED');process.exitCode=1;});
module.exports={audit,apply,triggers};

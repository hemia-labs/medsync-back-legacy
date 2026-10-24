'use strict';
// Explicit maintenance only; never removes accounts, identities, legal evidence or outbox.
const mysql=require('mysql2/promise');
const policies=[
    ['registration_contact_challenge','expires_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)'],
    ['registration_rate_bucket','expires_at < UTC_TIMESTAMP(3)'],
    ['registration_attempt','expires_at < UTC_TIMESTAMP(3)']
];
async function inspect(db) {
    const result={};for(const [table,where] of policies){const [rows]=await db.query(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`);result[table]=Number(rows[0].n);}return result;
}
async function prune(db) {
    const result={};await db.beginTransaction();
    try{for(const [table,where] of policies){const [rows]=await db.query(`DELETE FROM ${table} WHERE ${where} LIMIT 500`);result[table]=rows.affectedRows;}await db.commit();return result;}
    catch(error){await db.rollback();throw error;}
}
async function main(){
    const config=require('../../src/config/config'),args=process.argv.slice(2),apply=args.includes('--apply');
    if(apply&&(!args.includes('--expect-database')||args[args.indexOf('--expect-database')+1]!==config.DATABASEMYSQL))throw Error('S24C_EXACT_TARGET_REQUIRED');
    const db=await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL});
    try{console.log(JSON.stringify({readOnly:!apply,counts:apply?await prune(db):await inspect(db)},null,2));}finally{await db.end();}
}
if(require.main===module)main().catch(()=>{console.error('S24C_RETENTION_FAILED');process.exitCode=1;});
module.exports={inspect,prune};

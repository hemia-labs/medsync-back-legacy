const fs=require('node:fs');
const path=require('node:path');
const mysql=require('mysql2/promise');
const c=require('../../src/config/config');

(async()=>{
    const db=await mysql.createConnection({host:c.HOSTMYSQL,port:c.PORTMYSQL,user:c.USERMYSQL,password:c.PASSWORDMYSQL,database:c.DATABASEMYSQL});
    try {
        const root=path.resolve(__dirname,'../../..');
        const backup=path.join(root,'_schema_backups',`s10-${new Date().toISOString().replace(/[:.]/g,'-')}`);
        fs.mkdirSync(backup,{recursive:true});
        const [exists]=await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='business_role_permission'");
        for(const name of ['rol','permission_rol',...(exists.length ? ['business_role_permission'] : [])]) {
            const [rows]=await db.query(`SHOW CREATE TABLE ${name}`);
            fs.writeFileSync(path.join(backup,`${name}.sql`),rows[0]['Create Table']+';\n');
        }
        await db.query(fs.readFileSync(path.join(__dirname,'sql/business_role_permission.sql'),'utf8'));
        console.log(JSON.stringify({installed:'business_role_permission',backup,seeded:0,globalPermissionsChanged:0}));
    } finally { await db.end(); }
})().catch(error=>{console.error(error.message);process.exitCode=1;});

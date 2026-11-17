'use strict';
const mysql=require('mysql2/promise');
const config=require('../../src/config/config');
const columns={billing_snapshot:'JSON NULL',billing_revision:'DECIMAL(65,0) UNSIGNED NOT NULL DEFAULT 0',billing_access_until:'DATETIME(3) NULL'};
async function migrate(connection,apply=false) {
    await connection.query('SET SESSION lock_wait_timeout=10');
    const [existing]=await connection.query('SHOW COLUMNS FROM business');
    const names=new Set(existing.map(column=>column.Field));
    const missing=Object.keys(columns).filter(name=>!names.has(name));
    if(missing.length&&apply)await connection.query('ALTER TABLE business '+missing.map(name=>'ADD COLUMN `'+name+'` '+columns[name]).join(', ')+', ALGORITHM=INSTANT');
    return {missing,applied:apply&&missing.length>0};
}
async function main() {
    const expected=process.argv.find(arg=>arg.startsWith('--expect-database='))?.slice('--expect-database='.length);
    if(!expected||expected!==config.DATABASEMYSQL)throw Error('Expected database must match configured database');
    const apply=process.argv.includes('--apply');
    if(apply&&process.env.NODE_ENV==='development'&&!['localhost','127.0.0.1','::1'].includes(config.HOSTMYSQL))throw Error('Local development database required');
    const connection=await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL,multipleStatements:false});
    try {console.log(JSON.stringify(await migrate(connection,apply)));}finally{await connection.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
module.exports={migrate};

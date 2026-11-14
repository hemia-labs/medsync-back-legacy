'use strict';
// No connection by default. Explicit apply is an operator action, never imported by app startup.
const migration=require('./nc1-identity');
const {InstallationError,safeCause}=require('./nc1-install-error');
async function main(args=process.argv.slice(2)) {
 if(args.length===0 || args[0]==='plan') {console.log(JSON.stringify({checksum:migration.checksum,order:'nc4-catalogs -> nc1-identity -> app -> nc1-identity-catalog-fk',sql:[...migration.parentIndexes,...migration.statements]},null,2));return;}
 const [action,database,checksum,actor]=args;
 if(action!=='apply'||args.length!==4)throw new InstallationError('Usage: apply <database> <reviewed-checksum> <actor>; use plan first');
 if(checksum!==migration.checksum)throw new InstallationError('Reviewed checksum does not match this NC1 artifact; run plan and review it.');
 if(!/^[A-Za-z0-9_]{1,64}$/.test(database))throw new InstallationError('Invalid target database identifier.');
 if(!/^[A-Za-z0-9@._-]{1,100}$/.test(actor))throw new InstallationError('Invalid operator identifier.');
 const config=require('../../src/config/config');
 if(database!==config.DATABASEMYSQL)throw new InstallationError('Explicit database must match configured DB_NAME');
 const connection=await require('mysql2/promise').createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database});
 try {console.log(JSON.stringify(await migration.apply(connection,{expectedDatabase:database,expectedChecksum:checksum,actor})));}finally{await connection.end();}
}
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({event:'nc1.install.failed',...safeCause(error)}));process.exitCode=1;});
module.exports={main};

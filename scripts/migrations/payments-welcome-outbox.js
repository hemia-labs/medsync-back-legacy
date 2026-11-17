'use strict';
const mysql=require('mysql2/promise');
const fields=['subscription_id','id_business','id_login','payment_id','payload','created_at','claimed_at','sent_at','error_code'];
const create=`CREATE TABLE payments_welcome_outbox (
    subscription_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    id_business VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_login VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    claimed_at DATETIME(3) NULL,
    sent_at DATETIME(3) NULL,
    error_code VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NULL,
    KEY idx_payments_welcome_pending (claimed_at,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
async function migrate(connection,apply=false) {
    const [tables]=await connection.query("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payments_welcome_outbox'");
    if(tables.length) {
        const [columns]=await connection.query('SHOW COLUMNS FROM payments_welcome_outbox');
        const [indexes]=await connection.query('SHOW INDEX FROM payments_welcome_outbox');
        if(tables.length!==1||tables[0].ENGINE!=='InnoDB'||!fields.every(field=>columns.some(c=>c.Field===field))
            ||!indexes.some(i=>i.Key_name==='PRIMARY'&&i.Column_name==='subscription_id')
            ||indexes.filter(i=>i.Key_name==='PRIMARY').length!==1)throw Error('PAYMENTS_WELCOME_SCHEMA_REQUIRES_REVIEW');
        return {migration:'payments_welcome_outbox',alreadyApplied:true,applied:false};
    }
    if(apply)await connection.query(create);
    return {migration:'payments_welcome_outbox',alreadyApplied:false,applied:apply};
}
async function main() {
    const config=require('../../src/config/config'),apply=process.argv.includes('--apply');
    const expected=process.argv.find(arg=>arg.startsWith('--expect-database='))?.slice('--expect-database='.length);
    if(!expected||expected!==config.DATABASEMYSQL)throw Error('PAYMENTS_WELCOME_DATABASE_MISMATCH');
    if(apply&&process.env.NODE_ENV==='development'&&!['localhost','127.0.0.1','::1'].includes(config.HOSTMYSQL))throw Error('PAYMENTS_WELCOME_LOCAL_DATABASE_REQUIRED');
    const connection=await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,
        password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL,multipleStatements:false});
    try{console.log(JSON.stringify(await migrate(connection,apply)));}finally{await connection.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.code||(/^PAYMENTS_WELCOME_/.test(error.message)?error.message:'PAYMENTS_WELCOME_MIGRATION_FAILED'));process.exitCode=1;});
module.exports={migrate,fields,create};

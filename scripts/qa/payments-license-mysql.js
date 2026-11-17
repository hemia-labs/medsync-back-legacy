'use strict';
// One local connection, and a TEMPORARY business table shadowing the real table.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const mysql=require('mysql2/promise');
const config=require('../../src/config/config');
const {LicenseProjection}=require('../../src/services/payments/licenseProjection');
async function main() {
    assert(process.argv.includes('--local'));assert.equal(process.env.NODE_ENV,'development');
    assert(['localhost','127.0.0.1','::1'].includes(config.HOSTMYSQL));
    const connection=await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,
        password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL,namedPlaceholders:true,connectTimeout:5000});
    let created=false,failAfterWrite=false,chain=Promise.resolve();
    const db={transaction(callback){const next=chain.then(async()=>{await connection.beginTransaction();try{const value=await callback({});await connection.commit();return value;}catch(error){await connection.rollback();throw error;}});chain=next.catch(()=>{});return next;},
        async query(sql,options){const formatted=sql.replace(/:([A-Za-z]\w*)/g,(_,key)=>connection.escape(options.replacements[key]));
            const [rows]=await connection.query(formatted);
            if(failAfterWrite&&sql.startsWith('UPDATE'))throw Error('synthetic storage failure');return /^SELECT/.test(sql)?rows:[rows,rows.affectedRows];}};
    try {
        await connection.query(`CREATE TEMPORARY TABLE business(id_business CHAR(36) PRIMARY KEY,active TINYINT,status VARCHAR(20),
            subscription_status VARCHAR(30),plan VARCHAR(30),billing_snapshot JSON,billing_revision DECIMAL(65,0) UNSIGNED NOT NULL DEFAULT 0,
            billing_access_until DATETIME(3),trial_ends_at DATETIME(3),current_period_ends_at DATETIME(3),updated_at DATETIME,updated_by VARCHAR(30))`);
        created=true;
        const organizationId=randomUUID(),subscriptionId=randomUUID();
        await connection.execute("INSERT INTO business(id_business,active,status,subscription_status,plan,trial_ends_at) VALUES(?,1,'active','trial','pro','2090-01-01')",[organizationId]);
        const snapshot=(revision,active=true)=>({organizationId,productCode:'medsync',revision,confirmedAt:new Date().toISOString(),
            license:{active,productCode:'medsync',planCode:'medsync_pro',licenseStatus:active?'active':'revoked',validUntil:new Date(Date.now()+30*86400000).toISOString(),seatsLimit:4,usageLimit:null,subscriptionId,features:{'professionals.included':1,'users.auxiliary.included':3,'branches.included':1}},
            subscription:{id:subscriptionId,organizationId,productCode:'medsync',planCode:'medsync_pro',planPriceCode:'monthly',status:active?'active':'cancelled',currentPeriodEnd:null,nextBillingTime:null,cancelAtPeriodEnd:false,cancellation:null,pendingPlanChange:null}});
        const projection=new LicenseProjection(db);
        const current=async()=>(await connection.query('SELECT * FROM business'))[0][0];
        await projection.apply(snapshot('9007199254740993000',false));assert.equal((await current()).subscription_status,'trial');
        assert.equal((await projection.apply(snapshot('9007199254740992999'))).applied,false);
        await projection.apply(snapshot('9007199254740993001'));let paid=await current();
        assert.equal(paid.billing_revision,'9007199254740993001');assert.equal(paid.subscription_status,'active');assert.equal(paid.plan,'pro');
        const until=paid.billing_access_until.getTime(),trial=paid.trial_ends_at.getTime();
        assert.equal((await projection.apply(snapshot('9007199254740993001'))).applied,false);assert.equal((await current()).billing_access_until.getTime(),until);
        await projection.apply(snapshot('9007199254740993002'));assert.equal((await current()).billing_revision,'9007199254740993002');
        await Promise.all([projection.apply(snapshot('9007199254740993004',false)),projection.apply(snapshot('9007199254740993003'))]);
        paid=await current();assert.equal(paid.billing_revision,'9007199254740993004');assert.equal(paid.subscription_status,'cancelled');assert.equal(paid.trial_ends_at.getTime(),trial);
        failAfterWrite=true;await assert.rejects(projection.apply(snapshot('9007199254740993005')));failAfterWrite=false;
        paid=await current();assert.equal(paid.billing_revision,'9007199254740993004');assert.equal(paid.subscription_status,'cancelled');
        await connection.query("UPDATE business SET status='suspended',active=0");await projection.apply(snapshot('9007199254740993006'));
        paid=await current();assert.equal(paid.active,0);assert.equal(paid.status,'suspended');
        console.log(JSON.stringify({result:'PASS',temporaryTableOnly:true,revisionPrecision:true,staleReplayIgnored:true,atomicRollback:true,manualSuspensionPreserved:true,purchasesCreated:0}));
    }finally{if(created)await connection.query('DROP TEMPORARY TABLE business');await connection.end();}
}
main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});

'use strict';
// Synthetic data only: one connection and TEMPORARY tables shadow every table used by this check.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const mysql=require('mysql2/promise');
const config=require('../../src/config/config');
const {LicenseProjection}=require('../../src/services/payments/licenseProjection');
const {sendNextContractWelcome}=require('../../src/services/payments/contractWelcome.service');
const {create}=require('../migrations/payments-welcome-outbox');
async function main() {
    assert(process.argv.includes('--local'));assert.equal(process.env.NODE_ENV,'development');
    assert(['localhost','127.0.0.1','::1'].includes(config.HOSTMYSQL));
    const connection=await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,
        password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL,connectTimeout:5000});
    const created=[];let chain=Promise.resolve(),failEnqueue=false;
    const db={transaction(callback){const next=chain.then(async()=>{await connection.beginTransaction();
        try{const value=await callback({});await connection.commit();return value;}catch(error){await connection.rollback();throw error;}});
        chain=next.catch(()=>{});return next;},
    async query(sql,options={}){
        const formatted=sql.replace(/:([A-Za-z]\w*)/g,(_,key)=>connection.escape(options.replacements[key]));
        const [rows]=await connection.query(formatted);
        if(failEnqueue&&sql.startsWith('INSERT INTO payments_welcome_outbox'))throw Error('synthetic enqueue failure');
        return /^SELECT/.test(sql)?rows:[rows,rows.affectedRows];
    }};
    try {
        const definitions={
            business:`CREATE TEMPORARY TABLE business(id_business VARCHAR(50) PRIMARY KEY,name VARCHAR(180),active TINYINT,status VARCHAR(20),
                subscription_status VARCHAR(30),plan VARCHAR(30),billing_snapshot JSON,billing_revision DECIMAL(65,0) UNSIGNED NOT NULL DEFAULT 0,
                billing_access_until DATETIME(3),current_period_ends_at DATETIME(3),updated_at DATETIME,updated_by VARCHAR(30)) ENGINE=InnoDB`,
            login:`CREATE TEMPORARY TABLE login(id_login VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),id_rol VARCHAR(50),
                email VARCHAR(254),first_name VARCHAR(100),name VARCHAR(180),active TINYINT,locked TINYINT) ENGINE=InnoDB`,
            rol:`CREATE TEMPORARY TABLE rol(id_rol VARCHAR(50) PRIMARY KEY,code VARCHAR(30),active TINYINT) ENGINE=InnoDB`,
            auth_identity:`CREATE TEMPORARY TABLE auth_identity(id_login VARCHAR(50),kind VARCHAR(20),normalized_value VARCHAR(254),
                reservation_status VARCHAR(20),verified_at DATETIME(3),expires_at DATETIME(3)) ENGINE=InnoDB`,
            payments_welcome_outbox:create.replace('CREATE TABLE','CREATE TEMPORARY TABLE')
        };
        for(const [name,sql] of Object.entries(definitions)){await connection.query(sql);created.push(name);}
        const organizationId=randomUUID(),userId=randomUUID(),subscriptionId=randomUUID(),paymentId=randomUUID(),roleId=randomUUID();
        await connection.execute("INSERT INTO business(id_business,name,active,status,subscription_status,plan) VALUES(?,'QA Consultorio',1,'active','trial','pro')",[organizationId]);
        await connection.execute("INSERT INTO rol VALUES(?,'admin',1)",[roleId]);
        await connection.execute("INSERT INTO login VALUES(?,?,?,'buyer@example.test','Ana','Ana QA',1,0)",[userId,organizationId,roleId]);
        await connection.execute("INSERT INTO auth_identity VALUES(?,'email','buyer@example.test','verified',NOW(3),NULL)",[userId]);
        const end=new Date(Date.now()+30*86400000).toISOString();
        const snapshot={organizationId,productCode:'medsync',revision:'9007199254740993001',confirmedAt:new Date().toISOString(),
            license:{active:true,productCode:'medsync',planCode:'medsync_pro',licenseStatus:'active',validUntil:end,seatsLimit:4,
                usageLimit:null,subscriptionId,features:{},billing:{checkoutConfirmation:{organizationId,productCode:'medsync',
                    subscriptionId,paymentId,userId,status:'completed',provider:'paypal',planCode:'medsync_pro',planPriceCode:'monthly',
                    planName:null,recurringAmount:'999.00',paidAmount:'749.50',currency:'MXN',billingInterval:'month',
                    billingIntervalCount:1,paidAt:new Date(Date.now()-60000).toISOString(),nextBillingAt:end}}},
            subscription:{id:subscriptionId,organizationId,productCode:'medsync',planCode:'medsync_pro',planPriceCode:'monthly',
                status:'active',currentPeriodEnd:end,nextBillingTime:end,cancelAtPeriodEnd:false,cancellation:null,pendingPlanChange:null}};
        const projection=new LicenseProjection(db);
        failEnqueue=true;await assert.rejects(projection.apply(snapshot),/synthetic enqueue failure/);failEnqueue=false;
        assert.equal((await connection.query('SELECT subscription_status FROM business'))[0][0].subscription_status,'trial');
        assert.equal((await connection.query('SELECT COUNT(*) n FROM payments_welcome_outbox'))[0][0].n,0);
        await projection.apply(snapshot);await projection.apply(snapshot);
        await Promise.all([projection.apply({...snapshot,revision:'9007199254740993002'}),projection.apply({...snapshot,revision:'9007199254740993003'})]);
        assert.equal((await connection.query('SELECT COUNT(*) n FROM payments_welcome_outbox'))[0][0].n,1);
        const deliveries=[];const send=async message=>{deliveries.push(message);return {success:true};};
        await Promise.all([sendNextContractWelcome(db,'https://example.test/login',send),sendNextContractWelcome(db,'https://example.test/login',send)]);
        assert.equal(deliveries.length,1);assert.equal(deliveries[0].to,'buyer@example.test');
        assert.equal(deliveries[0].variables.paidAmountLabel,'$749.50 MXN');
        assert((await connection.query('SELECT sent_at FROM payments_welcome_outbox'))[0][0].sent_at);
        assert.equal(await sendNextContractWelcome(db,'https://example.test/login',send),false);
        // A second contract with an unverified buyer must be consumed without a delivery.
        const next=structuredClone(snapshot),nextId=randomUUID();next.revision='9007199254740993004';
        next.subscription.id=nextId;next.license.subscriptionId=nextId;next.license.billing.checkoutConfirmation.subscriptionId=nextId;
        next.license.billing.checkoutConfirmation.paymentId=randomUUID();
        await connection.query("UPDATE auth_identity SET reservation_status='pending',verified_at=NULL");
        await projection.apply(next);await sendNextContractWelcome(db,'https://example.test/login',send);assert.equal(deliveries.length,1);
        const [[row]]=await connection.execute('SELECT error_code FROM payments_welcome_outbox WHERE subscription_id=?',[nextId]);
        assert.equal(row.error_code,'RECIPIENT_OR_CONTRACT_UNAVAILABLE');
        console.log(JSON.stringify({result:'PASS',temporaryTablesOnly:true,transactionRollback:true,durableUniqueness:true,
            concurrentWorkerClaims:true,verifiedNativeRecipient:true,syntheticDeliveries:deliveries.length,realEmailDeliveries:0,purchasesCreated:0}));
    }finally{
        for(const name of created.reverse())await connection.query('DROP TEMPORARY TABLE `'+name+'`');
        await connection.end();
    }
}
main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});

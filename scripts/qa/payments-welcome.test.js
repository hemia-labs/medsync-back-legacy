'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {LicenseProjection}=require('../../src/services/payments/licenseProjection');
const {confirmedPurchase,welcomeVariables,sendNextContractWelcome}=require('../../src/services/payments/contractWelcome.service');
const {migrate,fields}=require('../migrations/payments-welcome-outbox');
const businessId=randomUUID(),userId=randomUUID(),subscriptionId=randomUUID(),paymentId=randomUUID();
const loginUrl='https://example.test/login';
function snapshot(revision='1') {
    const end=new Date(Date.now()+30*86400000).toISOString();
    return {organizationId:businessId,productCode:'medsync',revision,confirmedAt:new Date().toISOString(),
        license:{active:true,productCode:'medsync',planCode:'medsync_pro',licenseStatus:'active',validUntil:end,
            seatsLimit:4,usageLimit:null,subscriptionId,features:{},billing:{checkoutConfirmation:{
                organizationId:businessId,productCode:'medsync',subscriptionId,paymentId,userId,status:'completed',
                planCode:'medsync_pro',planPriceCode:'monthly',planName:null,recurringAmount:'999.00',currency:'MXN',
                billingInterval:'month',billingIntervalCount:1,paidAmount:'749.50',paidAt:new Date(Date.now()-60000).toISOString(),
                provider:'paypal',nextBillingAt:end}}},
        subscription:{id:subscriptionId,organizationId:businessId,productCode:'medsync',planCode:'medsync_pro',planPriceCode:'monthly',
            status:'active',currentPeriodEnd:end,nextBillingTime:end,cancelAtPeriodEnd:false,cancellation:null,pendingPlanChange:null}};
}
function fixture() {
    let business={id_business:businessId,subscription_status:'trial',billing_revision:'0',billing_snapshot:null};
    let events=new Map(),chain=Promise.resolve(),eligible=true,failEnqueue=false,failClaim=false;
    const account={email:'buyer@example.test',first_name:'Ana',name:'Ana QA',clinic_name:'Clínica A & B'};
    const db={transaction(fn){const run=chain.then(async()=>{const before=structuredClone(business),queue=structuredClone(events);
        try{return await fn({transaction:true});}catch(e){business=before;events=queue;throw e;}});chain=run.catch(()=>{});return run;},
    async query(sql,{replacements:p={}}={}) {
        if(sql.startsWith('SELECT id_business'))return [{...business}];
        if(sql.startsWith('UPDATE business')) {business.billing_snapshot=JSON.parse(p.snapshot);
            if(p.revision)Object.assign(business,{billing_revision:p.revision,subscription_status:p.status});return [null,1];}
        if(sql.startsWith('INSERT INTO payments_welcome_outbox')) {
            if(failEnqueue)throw Error('synthetic outbox failure');
            if(!events.has(p.subscription))events.set(p.subscription,{subscription_id:p.subscription,id_business:p.business,id_login:p.login,
                payment_id:p.payment,payload:JSON.parse(p.payload),claimed_at:null,sent_at:null});return [null,1];
        }
        if(sql.startsWith('SELECT subscription_id'))return [...events.values()].filter(e=>!e.claimed_at).slice(0,1).map(e=>({...e}));
        if(sql.includes('FROM login'))return eligible&&p.login===userId&&p.business===businessId
            &&business.subscription_status==='active'?[{...account,...business}]:[];
        if(sql.startsWith('UPDATE payments_welcome_outbox SET claimed_at')) {
            if(failClaim)throw Error('synthetic claim failure');
            Object.assign(events.get(p.subscription),{claimed_at:new Date(),error_code:p.error});return [null,1];
        }
        if(sql.startsWith('UPDATE payments_welcome_outbox SET sent_at')) {
            Object.assign(events.get(p.subscription),{sent_at:p.error?null:new Date(),error_code:p.error});return [null,1];
        }
        throw Error('Unexpected offline SQL: '+sql);
    }};
    const messages=[],send=async message=>{messages.push(message);return {success:true};};
    return {db,projection:new LicenseProjection(db),send,messages,business:()=>business,events:()=>[...events.values()],
        eligible:value=>{eligible=value;},failEnqueue:value=>{failEnqueue=value;},failClaim:value=>{failClaim=value;}};
}
test('webhook replay, newer confirmations, concurrent workers and a worker restart send one welcome per subscription',async()=>{
    const f=fixture(),s=snapshot();await f.projection.apply(s);
    await Promise.all([f.projection.apply(s),f.projection.apply({...s,revision:'2'}),f.projection.apply({...s,revision:'3'})]);
    assert.equal(f.events().length,1);
    await Promise.all([sendNextContractWelcome(f.db,loginUrl,f.send),sendNextContractWelcome(f.db,loginUrl,f.send)]);
    assert.equal(f.messages.length,1);assert.equal(await sendNextContractWelcome(f.db,loginUrl,f.send),false);
    assert.equal(f.messages[0].to,'buyer@example.test');assert.equal(f.messages[0].type,'subscription-welcome');
    assert.equal(f.messages[0].variables.planName,'Profesional');assert.equal(f.messages[0].variables.paidAmountLabel,'$749.50 MXN');
    assert.equal(f.messages[0].variables.amountLabel,'$999 MXN');assert(f.events()[0].sent_at);
    await f.projection.apply({...s,revision:'4'});assert.equal(await sendNextContractWelcome(f.db,loginUrl,f.send),false);
});
test('license and durable notification commit together and a rolled back enqueue can be recovered',async()=>{
    const f=fixture();f.failEnqueue(true);await assert.rejects(f.projection.apply(snapshot()),/outbox failure/);
    assert.equal(f.business().subscription_status,'trial');assert.equal(f.business().billing_revision,'0');assert.equal(f.events().length,0);
    f.failEnqueue(false);await f.projection.apply(snapshot());assert.equal(f.events().length,1);
    f.failClaim(true);await assert.rejects(sendNextContractWelcome(f.db,loginUrl,f.send),/claim failure/);assert.equal(f.messages.length,0);assert.equal(f.events()[0].claimed_at,null);
    f.failClaim(false);await sendNextContractWelcome(f.db,loginUrl,f.send);assert.equal(f.messages.length,1);
});
test('an unknown SES response is recorded and never retried into a duplicate delivery',async()=>{
    for(const throws of [true,false]) {
        const f=fixture();await f.projection.apply(snapshot());let calls=0;
        const previous=console.warn;console.warn=()=>{};
        try {await sendNextContractWelcome(f.db,loginUrl,async()=>{calls++;if(throws)throw Error('lost response');return {success:false};});}
        finally {console.warn=previous;}
        assert.equal(f.events()[0].error_code,'EMAIL_DELIVERY_UNCONFIRMED');assert.equal(f.events()[0].sent_at,null);
        await f.projection.apply(snapshot('2'));await sendNextContractWelcome(f.db,loginUrl,async()=>{calls++;return {success:true};});assert.equal(calls,1);
    }
});
test('active licenses without a real completed payment and invalid or foreign confirmations never enqueue',async()=>{
    const changes=[c=>{c.status='pending';},c=>{c.status='refunded';},c=>{c.status='reversed';},c=>{c.paidAmount='0.00';},
        c=>{c.organizationId=randomUUID();},c=>{c.subscriptionId=randomUUID();},c=>{c.productCode='other';},
        c=>{c.planCode='other';},c=>{c.planPriceCode='other';},c=>{c.userId='invalid';},c=>{c.provider='manual';},
        c=>{c.recurringAmount='1e3';},c=>{c.paidAmount='999.999';},c=>{c.billingIntervalCount=0;},
        c=>{c.paidAt=new Date(Date.now()+600000).toISOString();}];
    for(const change of changes) {const f=fixture(),s=snapshot();change(s.license.billing.checkoutConfirmation);await f.projection.apply(s);assert.equal(f.events().length,0);}
    for(const scenario of ['no-payment','grace','pending']) {const f=fixture(),s=snapshot();
        if(scenario==='no-payment')delete s.license.billing.checkoutConfirmation;
        if(scenario==='grace'){s.license.licenseStatus='grace';s.subscription.status='past_due';}
        if(scenario==='pending')s.subscription.status='pending';
        await f.projection.apply(s);assert.equal(f.events().length,0);}
});
test('confirmation cannot bypass native pending activation or stale snapshot revision',async()=>{
    const f=fixture();f.business().subscription_status='pending_activation';await f.projection.apply(snapshot());assert.equal(f.events().length,0);
    f.business().subscription_status='trial';assert.equal((await f.projection.apply(snapshot())).applied,false);assert.equal(f.events().length,0);
    await f.projection.apply(snapshot('2'));assert.equal(f.events().length,1);
});
test('the original recipient must still be authorized and the paid license must remain valid before delivery',async()=>{
    for(const scenario of ['recipient','expired','cancelled']) {const f=fixture();await f.projection.apply(snapshot());
        if(scenario==='recipient')f.eligible(false);
        if(scenario==='expired')f.business().billing_snapshot.confirmedAt=new Date(Date.now()-86400001).toISOString();
        if(scenario==='cancelled'){f.business().billing_snapshot.subscription.status='cancelled';f.business().billing_snapshot.license.active=false;f.business().billing_snapshot.license.licenseStatus='revoked';}
        await sendNextContractWelcome(f.db,loginUrl,f.send);assert.equal(f.messages.length,0);assert.equal(f.events()[0].error_code,'RECIPIENT_OR_CONTRACT_UNAVAILABLE');}
});
test('frozen purchase data, annual intervals and confirmed future renewal determine the email',()=>{
    const s=snapshot(),p=confirmedPurchase(s);p.billingInterval='year';p.billingIntervalCount=2;
    const values=welcomeVariables(p,s,{first_name:'Ana',clinic_name:'Clínica QA'},loginUrl);
    assert.equal(values.billingIntervalLabel,'2 años');assert.match(values.renewalNotice,/cada 2 años/);assert(values.nextBillingAtLabel);
    s.subscription.cancelAtPeriodEnd=true;assert.equal(welcomeVariables(p,s,{},loginUrl).nextBillingAtLabel,undefined);
    s.subscription.cancelAtPeriodEnd=false;p.nextBillingAt=null;assert.equal(welcomeVariables(p,s,{},loginUrl).renewalNotice,undefined);
    assert.equal(values.trialDurationLabel,undefined);assert.equal(values.trialEndsAtLabel,undefined);
});
test('a later subscription can receive its own welcome without reopening the first one',async()=>{
    const f=fixture();await f.projection.apply(snapshot());await sendNextContractWelcome(f.db,loginUrl,f.send);
    const s=snapshot('2'),id=randomUUID();s.subscription.id=id;s.license.subscriptionId=id;s.license.billing.checkoutConfirmation.subscriptionId=id;
    s.license.billing.checkoutConfirmation.paymentId=randomUUID();await f.projection.apply(s);await sendNextContractWelcome(f.db,loginUrl,f.send);
    assert.equal(f.events().length,2);assert.equal(f.messages.length,2);
});
test('outbox migration is additive, idempotent and rejects a partial or non-transactional schema',async()=>{
    let writes=0;const absent={async query(sql){if(sql.startsWith('CREATE'))writes++;return [[]];}};
    assert.equal((await migrate(absent)).applied,false);assert.equal(writes,0);assert.equal((await migrate(absent,true)).applied,true);assert.equal(writes,1);
    for(const invalid of ['missing-column','missing-key','wrong-engine',null]) {const db={async query(sql){
        if(sql.includes('information_schema'))return [[{ENGINE:invalid==='wrong-engine'?'MyISAM':'InnoDB'}]];
        if(sql.startsWith('SHOW COLUMNS'))return [fields.slice(invalid==='missing-column'?1:0).map(Field=>({Field}))];
        return [invalid==='missing-key'?[]:[{Key_name:'PRIMARY',Column_name:'subscription_id'}]];}};
        if(invalid)await assert.rejects(migrate(db,true),/SCHEMA_REQUIRES_REVIEW/);else assert.equal((await migrate(db,true)).alreadyApplied,true);}
});
test('readiness refuses a missing outbox or missing durable uniqueness before starting workers',async()=>{
    const previous=process.env.PAYMENTS_CONNECTION;process.env.PAYMENTS_CONNECTION='synthetic';
    const {createReadiness}=require('../../src/services/readiness');let mode='missing';
    const db={async sync(){},async query(sql){
        if(sql.includes('patient_code_counter'))return [{next_value:1}];
        if(sql==='SHOW INDEX FROM person')return [{Key_name:'code',Column_name:'code',Non_unique:0}];
        if(sql==='SHOW COLUMNS FROM business')return ['billing_snapshot','billing_revision','billing_access_until'].map(Field=>({Field}));
        if(sql==='SHOW COLUMNS FROM payments_welcome_outbox')return mode==='missing'?[]:fields.map(Field=>({Field}));
        if(sql==='SHOW INDEX FROM payments_welcome_outbox')return mode==='valid'?[{Key_name:'PRIMARY',Column_name:'subscription_id',Non_unique:0}]:[];
        throw Error('Unexpected SQL');}};
    try {await assert.rejects(createReadiness(db).initialize(),/PAYMENTS_WELCOME_MIGRATION_REQUIRED/);mode='no-key';
        await assert.rejects(createReadiness(db).initialize(),/PAYMENTS_WELCOME_MIGRATION_REQUIRED/);mode='valid';await createReadiness(db).initialize();}
    finally {if(previous===undefined)delete process.env.PAYMENTS_CONNECTION;else process.env.PAYMENTS_CONNECTION=previous;}
});

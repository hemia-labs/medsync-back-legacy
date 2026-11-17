'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {QueryTypes}=require('sequelize');
const {LicenseProjection}=require('../../src/services/payments/licenseProjection');
const {commercialState,paidPlan,managed}=require('../../src/services/payments/paidLicense');
const {isBusinessOperational}=require('../../src/util/businessOperational');
const {getEffectiveDashboardCapabilities}=require('../../src/config/dashboardCapabilities');
const businessId=randomUUID(),subscriptionId=randomUUID();
function snapshot(revision='1',changes={}) {
    const now=Date.now(),end=new Date(now+30*86400000).toISOString();
    const base={organizationId:businessId,productCode:'medsync',revision,confirmedAt:new Date(now).toISOString(),
        license:{active:true,productCode:'medsync',planCode:'medsync_pro',licenseStatus:'active',validUntil:end,
            seatsLimit:4,usageLimit:null,subscriptionId,features:{'professionals.included':1,'users.auxiliary.included':3,'branches.included':1,'clinical_templates.custom':true,'dashboard.operational':true}},
        subscription:{id:subscriptionId,organizationId:businessId,productCode:'medsync',planCode:'medsync_pro',planPriceCode:'monthly',status:'active',currentPeriodEnd:end,nextBillingTime:end,cancelAtPeriodEnd:false,cancellation:null,pendingPlanChange:null}};
    return {...base,...changes,license:{...base.license,...changes.license},subscription:changes.subscription===null?null:{...base.subscription,...changes.subscription}};
}
function fixture(initial={}) {
    const business={id_business:businessId,active:1,status:'active',subscription_status:'trial',plan:'pro',
        billing_revision:'0',billing_snapshot:null,billing_access_until:null,trial_ends_at:new Date(Date.now()+15*86400000),...initial};
    const trial=business.trial_ends_at;let chain=Promise.resolve(),writes=0;
    const db={transaction(fn){const next=chain.then(()=>fn({}));chain=next.catch(()=>{});return next;},
        async query(sql,options){
            if(options.type===QueryTypes.SELECT)return [{...business}];
            const p=options.replacements;writes++;
            business.billing_snapshot=JSON.parse(p.snapshot);
            if(p.revision)Object.assign(business,{billing_revision:p.revision,billing_access_until:p.accessUntil,
                subscription_status:p.status,plan:p.plan||business.plan,current_period_ends_at:p.periodEnd});
            return [null,1];
        }};
    return {business,trial,projection:new LicenseProjection(db),writes:()=>writes};
}
test('verified license projects plan, validity and limits without restarting trial or changing manual flags',async()=>{
    const f=fixture({active:0,status:'suspended'}),s=snapshot();
    assert.deepEqual(await f.projection.apply(s),{applied:true});
    assert.equal(f.business.subscription_status,'active');assert.equal(f.business.plan,'pro');
    assert.equal(f.business.trial_ends_at,f.trial);assert.equal(f.business.active,0);assert.equal(f.business.status,'suspended');
    assert.equal(isBusinessOperational(f.business).allowed,false);
    const plan=paidPlan(f.business);assert.equal(plan.maxAuxiliaryUsers,3);assert.equal(plan.maxProfessionals,1);
    assert(f.business.billing_access_until.getTime()<=Date.parse(s.confirmedAt)+86400000);
});
test('large revisions and out-of-order/repeated delivery cannot restore old plan or extend the confirmation',async()=>{
    const f=fixture();await f.projection.apply(snapshot('9007199254740993001'));
    const until=f.business.billing_access_until.getTime(),confirmed=f.business.billing_snapshot.confirmedAt;
    assert.equal((await f.projection.apply(snapshot('9007199254740993000',{license:{planCode:'medsync_basic'},subscription:{planCode:'medsync_basic'}}))).applied,false);
    assert.equal((await f.projection.apply(snapshot('9007199254740993001'))).applied,false);
    assert.equal(f.business.billing_access_until.getTime(),until);assert.equal(f.business.billing_snapshot.confirmedAt,confirmed);assert.equal(f.writes(),1);
});
test('concurrent reversed delivery retains the highest revision and its revocation',async()=>{
    const f=fixture();await Promise.all([f.projection.apply(snapshot('3')),f.projection.apply(snapshot('5',{license:{active:false,licenseStatus:'revoked'},subscription:{status:'cancelled'}})),f.projection.apply(snapshot('4'))]);
    assert.equal(f.business.billing_revision,'5');assert.equal(f.business.subscription_status,'cancelled');assert.equal(isBusinessOperational(f.business).allowed,false);
});
test('an inactive first observation prevents an older paid delivery from granting access',async()=>{
    const f=fixture();await f.projection.apply(snapshot('5',{license:{active:false,licenseStatus:'revoked'},subscription:{status:'cancelled'}}));
    assert.equal(f.business.billing_revision,'0');assert.equal(f.business.subscription_status,'trial');
    assert.equal((await f.projection.apply(snapshot('4'))).applied,false);assert.equal(f.business.subscription_status,'trial');
    await f.projection.apply(snapshot('6'));assert.equal(f.business.subscription_status,'active');assert.equal(f.business.billing_revision,'6');
});
test('unpaid pending/missing license preserves native trial; paid cancellation never restores it',async()=>{
    const f=fixture(),inactive={license:{active:false,planCode:null,subscriptionId:null,licenseStatus:'expired'},subscription:null};
    assert.equal((await f.projection.apply(snapshot('1',inactive))).applied,true);assert.equal(managed(f.business),false);
    assert.equal(f.business.subscription_status,'trial');assert.equal(f.business.trial_ends_at,f.trial);
    await f.projection.apply(snapshot('2'));await f.projection.apply(snapshot('3',inactive));
    assert(managed(f.business));assert.equal(f.business.subscription_status,'past_due');assert.equal(f.business.trial_ends_at,f.trial);
    assert.equal(isBusinessOperational(f.business).allowed,false);
});
test('pending activation cannot gain access from a delivery',async()=>{
    const f=fixture({subscription_status:'pending_activation'});await f.projection.apply(snapshot());assert.equal(f.business.subscription_status,'pending_activation');assert.equal(f.business.billing_revision,'0');
});
test('pending-to-trial handoff retains the observed revision barrier',async()=>{
    const f=fixture({subscription_status:'pending_activation'});
    await f.projection.apply(snapshot('5',{license:{active:false,licenseStatus:'revoked'},subscription:{status:'cancelled'}}));
    f.business.subscription_status='trial';assert.equal((await f.projection.apply(snapshot('4'))).applied,false);
    assert.equal(f.business.subscription_status,'trial');await f.projection.apply(snapshot('6'));assert.equal(f.business.subscription_status,'active');
});
test('stale, pending or unknown first snapshots preserve an untouched trial',async()=>{
    for(const s of [snapshot('1',{subscription:{status:'pending'}}),snapshot('1',{license:{planCode:'unknown'},subscription:{planCode:'unknown'}}),snapshot('1',{confirmedAt:new Date(Date.now()-86400001).toISOString()})]) {
        const f=fixture();assert.equal((await f.projection.apply(s)).applied,true);assert.equal(f.business.subscription_status,'trial');assert.equal(f.business.billing_revision,'0');assert.equal(f.business.trial_ends_at,f.trial);
    }
});
test('scheduled cancellation keeps access until authoritative license expires; renewal extends it',async()=>{
    const f=fixture(),end=new Date(Date.now()+3600000).toISOString();
    await f.projection.apply(snapshot('1',{license:{validUntil:end},subscription:{status:'cancelled',cancelAtPeriodEnd:true,currentPeriodEnd:end,nextBillingTime:null,cancellation:{state:'scheduled',requestedAt:new Date().toISOString(),effectiveAt:end}}}));
    assert(isBusinessOperational(f.business).allowed);assert.equal(f.business.billing_access_until.getTime(),Date.parse(end));
    await f.projection.apply(snapshot('2'));assert(f.business.billing_access_until.getTime()>Date.parse(end));
});
test('grace follows Billing; pending, unknown plans and expired confirmations never activate',()=>{
    assert.equal(commercialState(snapshot('1',{license:{licenseStatus:'grace'},subscription:{status:'past_due'}})).status,'active');
    for(const s of [snapshot('1',{subscription:{status:'pending'}}),snapshot('1',{license:{planCode:'unrecognized'},subscription:{planCode:'unrecognized'}}),snapshot('1',{confirmedAt:new Date(Date.now()-86400001).toISOString()})])assert.notEqual(commercialState(s).status,'active');
});
test('managed access fails closed on expired/missing confirmation and manual suspension, legacy licenses remain compatible',()=>{
    for(const changes of [{billing_access_until:new Date(Date.now()-1)},{billing_access_until:null},{status:'suspended'}])assert.equal(isBusinessOperational({active:1,status:'active',subscription_status:'active',billing_revision:'1',billing_access_until:new Date(Date.now()+10000),...changes}).allowed,false);
    assert(isBusinessOperational({active:1,status:'active',subscription_status:'active'}).allowed);
});
test('central limits are finite and no local default or corrupt copy grants capabilities',async()=>{
    const f=fixture();await f.projection.apply(snapshot('1',{license:{features:{'professionals.included':0,'users.auxiliary.included':2}}}));
    let plan=paidPlan(f.business);assert.equal(plan.maxProfessionals,0);assert.equal(plan.maxAuxiliaryUsers,2);assert.equal(plan.maxBranches,0);
    assert.equal(getEffectiveDashboardCapabilities(plan.code,plan.billingFeatures).capabilities.trends,false);
    f.business.billing_snapshot={};plan=paidPlan(f.business);assert.equal(plan.maxAuxiliaryUsers,0);assert.deepEqual(plan.billingFeatures,{});
});
test('clinic dashboard capabilities use the canonical Billing dashboard.admin flag',()=>{
    const enabled=getEffectiveDashboardCapabilities('enterprise',{'dashboard.admin':true});
    assert(enabled.capabilities.professionalBreakdown);assert(enabled.capabilities.advancedReports);assert(enabled.capabilities.operationalAnalysis);
    assert.equal(getEffectiveDashboardCapabilities('enterprise',{}).capabilities.advancedReports,false);
});
test('cross-product, invalid org and inconsistent subscription/plan are rejected before storage',async()=>{
    const f=fixture();for(const s of [snapshot('1',{productCode:'other'}),snapshot('1',{organizationId:'invalid'}),snapshot('1',{subscription:{planCode:'other'}})])await assert.rejects(f.projection.apply(s));
    assert.equal(f.writes(),0);
});
test('paid limits ignore local extensions and features follow explicit central entitlements',async()=>{
    const dbPath=require.resolve('../../src/db/Sequelize.connection'),previous=require.cache[dbPath];
    require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{query(){throw Error('No real database allowed');}}};
    const usage=require('../../src/Dao/mysql/licenseUsage.dao');
    const originals={getBusinessPlan:usage.getBusinessPlan,getBusinessLicenseUsage:usage.getBusinessLicenseUsage,getBusinessLicenseOverride:usage.getBusinessLicenseOverride};
    const f=fixture();await f.projection.apply(snapshot());let overrideCalls=0;
    usage.getBusinessPlan=async()=>f.business;
    usage.getBusinessLicenseUsage=async()=>({professionals:1,auxiliaryUsers:2,staffUsers:2,branches:1});
    usage.getBusinessLicenseOverride=async()=>{overrideCalls++;return {extra_professionals:100,extra_auxiliary_users:100};};
    try {
        const {getBusinessEffectiveLicense}=require('../../src/util/licenseLimits');
        const features=require('../../src/util/planFeatures');
        const license=await getBusinessEffectiveLicense(businessId);assert.equal(license.effectiveLimits.auxiliaryUsers,3);assert.equal(overrideCalls,0);
        assert.equal(await features.isFeatureEnabledForBusiness(businessId,'custom_templates'),true);
        await f.projection.apply(snapshot('2',{license:{features:{'professionals.included':1,'users.auxiliary.included':1}}}));
        assert.equal(await features.isFeatureEnabledForBusiness(businessId,'custom_templates'),false);
        assert.equal(await features.isFeatureEnabledForBusiness(businessId,'basic_dashboard'),false);
        await f.projection.apply(snapshot('3',{license:{planCode:'medsync_clinic',features:{'clinical_templates.by_professional_or_specialty':true,'documents.enabled':true,'dashboard.admin':true}},subscription:{planCode:'medsync_clinic'}}));
        assert.equal(await features.isFeatureEnabledForBusiness(businessId,'custom_templates'),true);
        assert.equal(await features.isFeatureEnabledForBusiness(businessId,'advanced_documents'),true);
        assert.equal(await features.isFeatureEnabledForBusiness(businessId,'premium_document_templates'),false);
    }finally{Object.assign(usage,originals);if(previous)require.cache[dbPath]=previous;else delete require.cache[dbPath];}
});
test('startup refuses Payments without the license migration',async()=>{
    const previous=process.env.PAYMENTS_CONNECTION;process.env.PAYMENTS_CONNECTION='synthetic';
    const {createReadiness}=require('../../src/services/readiness');let migrated=false;
    const db={async sync(){},async query(sql){if(sql.includes('patient_code_counter'))return [{next_value:1}];
        if(sql==='SHOW INDEX FROM payments_welcome_outbox')return [{Non_unique:0,Column_name:'subscription_id',Key_name:'PRIMARY'}];
        if(sql.startsWith('SHOW INDEX'))return [{Non_unique:0,Column_name:'code',Key_name:'unique_code'}];
        if(sql==='SHOW COLUMNS FROM payments_welcome_outbox')return require('../migrations/payments-welcome-outbox').fields.map(Field=>({Field}));
        if(sql.startsWith('SHOW COLUMNS'))return migrated?['billing_snapshot','billing_revision','billing_access_until'].map(Field=>({Field})):[];
        return [];}};
    try {await assert.rejects(createReadiness(db).initialize(),/PAYMENTS_LICENSE_MIGRATION_REQUIRED/);migrated=true;await createReadiness(db).initialize();}
    finally{if(previous===undefined)delete process.env.PAYMENTS_CONNECTION;else process.env.PAYMENTS_CONNECTION=previous;}
});

test('cancelled paid access is capped by period, central license and confirmation; revocation still wins',()=>{
    const end=new Date(Date.now()+3600000).toISOString();
    const changes={subscription:{status:'cancelled',cancelAtPeriodEnd:true,currentPeriodEnd:end,nextBillingTime:null}};
    assert.equal(commercialState(snapshot('1',changes)).accessUntil.getTime(),Date.parse(end));
    for(const extra of [
        {subscription:{...changes.subscription,cancelAtPeriodEnd:false}},
        {subscription:{...changes.subscription,currentPeriodEnd:new Date(Date.now()-1).toISOString()}},
        {license:{active:false,licenseStatus:'revoked'}},
        {license:{active:false,licenseStatus:'suspended'}},
        {license:{validUntil:new Date(Date.now()-1).toISOString()}},
        {confirmedAt:new Date(Date.now()-86400001).toISOString()}
    ])assert.notEqual(commercialState(snapshot('1',{...changes,...extra})).status,'active');
});

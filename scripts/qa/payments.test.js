'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {PaymentsError}=require('@hemia/payments');
const {PaymentsService,membershipId}=require('../../src/services/payments/payments.service');
const actor={id_login:randomUUID(),id_business:randomUUID(),id_session:randomUUID()};
function fixture() {
    const calls=[],sql=[];let row={...actor,rol:'admin',email_verified:1,subscription_status:'trial'};
    const receipt={attemptId:randomUUID(),operation:'checkout',status:'ready',statusFresh:true,checkoutId:randomUUID(),subscriptionId:randomUUID(),planCode:'medsync_pro',checkoutUrl:'https://www.sandbox.paypal.com/approve'};
    const client={verifyCompatibility:async()=>({}),catalog:{listPlans:async()=>[{code:'medsync_pro',name:'Pro',prices:[{code:'monthly',amount:'999.00',currency:'MXN',billingInterval:'month',billingIntervalCount:1}],features:[{code:'users.included',value:3}]}]},
        attempts:{create:async input=>{calls.push(['create',input]);return {...receipt,attemptId:input.idempotencyKey};},get:async(id,context)=>{calls.push(['get',id,context]);return {...receipt,attemptId:id};},retry:async(id,context)=>{calls.push(['retry',id,context]);return {...receipt,attemptId:id};}},
        checkout:{verify:async id=>{calls.push(['verify',id]);return {checkoutId:id,subscriptionId:receipt.subscriptionId};}},subscriptions:{current:async id=>{calls.push(['subscription',id]);return {id:receipt.subscriptionId};}},licenses:{resolve:async id=>{calls.push(['license',id]);return {active:true,productCode:'medsync',planCode:'medsync_pro',subscriptionId:receipt.subscriptionId};}}};
    client.snapshots={current:async id=>{calls.push(['snapshot',id]);return {organizationId:id,license:await client.licenses.resolve(id)};}};
    const projection={apply:async snapshot=>{calls.push(['project',snapshot.organizationId]);return {applied:true};}};
    const db={query:async(query,options)=>{assert.match(query,/^SELECT/);sql.push([query,options]);if(!row||options.replacements.login!==actor.id_login||options.replacements.business!==actor.id_business)return [];if(query.includes('JOIN `session`')&&options.replacements.session!==actor.id_session)return [];return [row];}};
    let service;
    const runtime={config:{successUrl:'https://consumer.test/old-success',cancelUrl:'https://consumer.test/old-cancel',receiver:{audience:'medsync-api'},legal:{verificationClientId:'legal-test'}},client,
        legal:{prepare:async(context,key)=>{calls.push(['prepare',context,key]);return {requestId:randomUUID(),documents:[]};},accept:async(context,input)=>{calls.push(['accept',context,input]);return {accepted:true};},resolveContext:input=>service.resolveLegalContext(input)},
        receiver:{verifyLegal:async headers=>{calls.push(['verifyLegal',headers]);if(headers.authorization!=='Bearer machine-test')throw new PaymentsError('authentication',401);}}};
    service=new PaymentsService(db,{runtime,projection});return {service,runtime,client,projection,calls,sql,receipt,setRow:value=>{row=value;},row:()=>row};
}
const payload=()=>({idempotencyKey:randomUUID(),planCode:'medsync_pro',planPriceCode:'monthly',legalAcceptanceId:randomUUID()});
test('checkout injects verified native identity and fixed return URLs; no provider/tenant/URL override',async()=>{
    const f=fixture(),body=payload();const result=await f.service.createAttempt(actor,body);
    assert.equal(result.attemptId,body.idempotencyKey);const sent=f.calls[0][1];assert.equal(sent.organizationId,actor.id_business);assert.equal(sent.userId,actor.id_login);assert.equal(sent.operation,'checkout');
    const url=new URL(sent.successUrl);assert.equal(url.origin,'https://consumer.test');assert.equal(url.pathname,'/cuenta/planes');assert.equal(url.searchParams.get('attempt_id'),body.idempotencyKey);assert.equal(url.searchParams.get('result'),'approved');
    for(const key of ['organizationId','userId','provider','providerConnectionId','successUrl','paid','amount','paypalApproval','providerSubscriptionId','clientId','environment'])await assert.rejects(f.service.createAttempt(actor,{...payload(),[key]:'untrusted'}),error=>error.status===400);
    assert.equal(f.calls.length,1);assert(f.sql.every(([query])=>!query.includes('UPDATE')));
});
test('PayPal window metadata comes only from the buyer-bound SDK receipt; resuming never creates or verifies a subscription',async()=>{
    const f=fixture(),body=payload();
    f.receipt.paypalApproval={kind:'subscription',subscriptionId:'I-SYNTHETIC123',clientId:'public-paypal-client',environment:'sandbox'};
    const created=await f.service.createAttempt(actor,body);
    assert.deepEqual(created.paypalApproval,f.receipt.paypalApproval);
    const resumed=await f.service.getAttempt(actor,body.idempotencyKey);
    assert.deepEqual(resumed.paypalApproval,created.paypalApproval);
    assert.equal(resumed.attemptId,created.attemptId);
    assert.equal(resumed.subscriptionId,created.subscriptionId);
    assert.equal(resumed.checkoutUrl,created.checkoutUrl);
    assert.deepEqual(f.calls.map(call=>call[0]),['create','get']);
    assert.deepEqual(f.calls[1][2],{organizationId:actor.id_business,userId:actor.id_login});
    for(const value of [f.receipt.paypalApproval,{subscriptionId:'I-ATTACKER',clientId:'attacker',environment:'live'}])
        await assert.rejects(f.service.createAttempt(actor,{...body,paypalApproval:value}),error=>error.status===400);
    assert.equal(f.calls.length,2,'Browser-supplied PayPal identifiers cannot reach Billing');
});
test('native membership UUID is stable for exact verified pair and differs by business',async()=>{
    const f=fixture(),context=await f.service.context(actor);assert.equal(context.membershipId,membershipId(actor.id_business,actor.id_login));assert.notEqual(context.membershipId,membershipId(randomUUID(),actor.id_login));
    await assert.rejects(f.service.context({...actor,id_business:randomUUID()}),error=>error.status===403);
    f.setRow({...f.row(),rol:'staff'});await assert.rejects(f.service.createAttempt(actor,payload()),error=>error.status===403);assert.equal(f.calls.length,0);
});
test('checkout requires current verified email and explicit checkout legal acceptance',async()=>{
    const f=fixture();for(const value of [0,'0',false]){f.setRow({...f.row(),email_verified:value});await assert.rejects(f.service.createAttempt(actor,payload()),error=>error.code==='CONTACT_VERIFICATION_REQUIRED');}
    f.setRow({...f.row(),email_verified:1});const body=payload();delete body.legalAcceptanceId;await assert.rejects(f.service.createAttempt(actor,body),error=>error.code==='PAYMENT_LEGAL_ACCEPTANCE_REQUIRED');assert.equal(f.calls.length,0);
});
test('pending activation cannot purchase through native context or the activation alias; expired trials may pay',async()=>{
    const f=fixture();f.setRow({...f.row(),subscription_status:'pending_activation'});
    await assert.rejects(f.service.createAttempt(actor,payload()),error=>error.status===403);assert.equal(f.calls.length,0);
    const {AccountActivationService}=require('../../src/services/registration/accountActivation.service');
    const alias=new AccountActivationService({});alias.account=async()=>({email_verified:1,subscription_status:'pending_activation'});
    await assert.rejects(alias.checkout(actor,payload()),error=>error.status===403);
    f.setRow({...f.row(),subscription_status:'trial',trial_ends_at:'2000-01-01'});
    await f.service.createAttempt(actor,payload());assert.equal(f.calls.at(-1)[0],'create');
});
test('verify uses buyer-bound receipt, never an arbitrary checkout ID or callback query',async()=>{
    const f=fixture();const id=randomUUID();await f.service.verify(actor,id,{});
    assert.deepEqual(f.calls.map(call=>call[0]),['get','verify','snapshot','license','project','get']);assert.equal(f.calls[1][1],f.receipt.checkoutId);assert.deepEqual(f.calls[0][2],{organizationId:actor.id_business,userId:actor.id_login});
    await assert.rejects(f.service.verify(actor,id,{checkoutId:randomUUID(),paid:true}),error=>error.status===400);
});
test('GET never verifies a payment; license reads synchronize the authoritative projection; retries retain buyer and ID',async()=>{
    const f=fixture(),id=randomUUID();await f.service.getAttempt(actor,id);await f.service.subscription(actor);await f.service.license(actor);assert(!f.calls.some(call=>call[0]==='verify'));
    await f.service.retry(actor,id,{});assert.deepEqual(f.calls.at(-1),['retry',id,{organizationId:actor.id_business,userId:actor.id_login}]);await assert.rejects(f.service.retry(actor,id,{planCode:'different'}),error=>error.status===400);
});
test('Legal callback verifies machine token, acceptance needs live session, checkout validation does not revive it',async()=>{
    const f=fixture(),input={subjectId:actor.id_login,organizationId:actor.id_business,purpose:'acceptance',sessionId:actor.id_session};
    await assert.rejects(f.service.legalContext({},input),error=>error.status===401);assert.equal(f.sql.length,0);
    const result=await f.service.legalContext({authorization:'Bearer machine-test'},input);assert.equal(result.canContract,true);assert.deepEqual(result.roles,['admin']);
    await assert.rejects(f.service.legalContext({authorization:'Bearer machine-test'},{...input,sessionId:randomUUID()}),error=>error.status===403);
    const checked=await f.service.legalContext({authorization:'Bearer machine-test'},{subjectId:actor.id_login,organizationId:actor.id_business,purpose:'checkout_validation'});assert.equal(checked.canContract,true);assert(!f.sql.at(-1)[0].includes('JOIN `session`'));
    f.setRow({...f.row(),rol:'staff'});assert.equal((await f.service.resolveLegalContext({...input,purpose:'checkout_validation'})).canContract,false);
});
test('upstream machine authentication failures remain availability errors without token details',async()=>{
    const f=fixture();f.client.attempts.get=async()=>{throw new PaymentsError('authentication',401);};await assert.rejects(f.service.getAttempt(actor,randomUUID()),error=>error.status===503&&error.code==='BILLING_UNAVAILABLE');
});
test('failed local persistence never reports a paid license or successful verification and never recreates checkout',async()=>{
    const f=fixture();f.projection.apply=async()=>{throw Error('private database details');};
    await assert.rejects(f.service.license(actor),error=>error.status===503&&error.code==='BILLING_UNAVAILABLE');
    await assert.rejects(f.service.verify(actor,randomUUID(),{}),error=>error.status===503&&error.code==='BILLING_UNAVAILABLE');
    assert.equal(f.calls.filter(call=>call[0]==='verify').length,1);assert(!f.calls.some(call=>call[0]==='create'));
});
test('session authorization reads the committed business state without contacting Billing or extending a paid period',async()=>{
    const dbPath=require.resolve('../../src/db/Sequelize.connection'),ssoPath=require.resolve('../../src/auth/platformSso'),principalPath=require.resolve('../../src/auth/activePrincipal');
    const previous=[require.cache[dbPath],require.cache[ssoPath],require.cache[principalPath]];
    const payments=require('../../src/services/payments/payments.service'),configured=payments.configuredPayments;
    let billingCalls=0,reads=0,row={...actor,subscription_status:'active',rol:'admin'};
    payments.configuredPayments=()=>{billingCalls++;throw Error('Authorization must use the webhook projection');};
    require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{query:async(sql)=>{reads++;assert.match(sql,/s.active = 1/);return row?[{...row}]:[];}}};
    require.cache[ssoPath]={id:ssoPath,filename:ssoPath,loaded:true,exports:{principalAllowed:()=>true}};
    delete require.cache[principalPath];
    try {
        const activePrincipal=require(principalPath);
        assert.equal((await activePrincipal(actor)).subscription_status,'active');
        row.subscription_status='cancelled';assert.equal((await activePrincipal(actor)).subscription_status,'cancelled');
        assert.equal(await activePrincipal({...actor,id_business:randomUUID()}),null);
        row=null;assert.equal(await activePrincipal(actor),null);
        assert.equal(reads,4);assert.equal(billingCalls,0);
    }finally{
        payments.configuredPayments=configured;
        [dbPath,ssoPath,principalPath].forEach((path,index)=>{if(previous[index])require.cache[path]=previous[index];else delete require.cache[path];});
    }
});
test('catalog uses SDK once for concurrent/cache reads and requires receiver+Legal for checkout',async()=>{
    const f=fixture();let calls=0;f.client.catalog.listPlans=async()=>{calls++;return [{code:'medsync_pro',name:'Pro',prices:[],features:[]}];};f.runtime.config.receiver=null;
    const [one,two]=await Promise.all([f.service.plans(),f.service.plans()]);assert.equal(calls,1);assert.equal(one,two);assert.equal(one.checkoutAvailable,false);assert.equal(one.taxBehavior,'inclusive');
});
test('catalog preserves service plan descriptions and feature names, units and values',async()=>{
    const f=fixture();
    const plan={code:'custom-plan',name:'Nombre comercial del servicio',description:'Descripción del servicio',prices:[{code:'price',amount:'123.45',currency:'MXN',billingInterval:'month',billingIntervalCount:3}],features:[{code:'custom.feature',name:'Beneficio publicado',unit:'usuarios',value:7},{code:'disabled.feature',name:'Beneficio desactivado',unit:null,value:false}]};
    f.client.catalog.listPlans=async()=>[plan];
    const {offers}=await f.service.plans();
    assert.equal(offers[0].name,plan.name);assert.equal(offers[0].description,plan.description);
    assert.deepEqual(offers[0].prices,plan.prices);assert.deepEqual(offers[0].featureDetails,plan.features);
    assert.deepEqual(offers[0].features,{'custom.feature':7,'disabled.feature':false});
});

test('official SDK rejects forged Legal callback tokens before any membership lookup',async()=>{
    let queries=0;
    const connection={issuer:'https://identity.test',tokenUrl:'https://identity.test/oauth/token',clientId:'qa-medsync',baseUrl:'https://billing.test/api/v1',audience:'billing-api',productCode:'medsync',receiver:{audience:'medsync-api'},legal:{baseUrl:'https://legal.test',resource:'https://legal.test',audience:'legal-api',verificationClientId:'legal-qa'}};
    const service=new PaymentsService({query:async()=>{queries++;throw new Error('No query allowed');}},{env:{HEMIA_CLIENT_ID:'qa-medsync',HEMIA_CLIENT_SECRET:'synthetic-only',PAYMENTS_CONNECTION:JSON.stringify(connection)}});
    await assert.rejects(service.legalContext({authorization:'Bearer invalid'},{subjectId:actor.id_login,organizationId:actor.id_business,purpose:'checkout_validation'}),error=>error.status===401);
    assert.equal(queries,0);
    const mismatched=new PaymentsService({},{env:{HEMIA_CLIENT_ID:'different-client',HEMIA_CLIENT_SECRET:'synthetic-only',PAYMENTS_CONNECTION:JSON.stringify(connection)}});
    assert.throws(()=>mismatched.runtime(),error=>error.code==='BILLING_UNAVAILABLE'&&!error.message.includes('synthetic-only'));
});

test('HTTP applies Origin and session CSRF, keeps machine callback separate, sanitizes failures',async()=>{
    process.env.CSRF_ALLOWED_ORIGINS='https://consumer.test';
    const path=require.resolve('../../src/db/Sequelize.connection');require.cache[path]={id:path,filename:path,loaded:true,exports:{query:async()=>{throw new Error('No real DB permitted');}}};
    const {createRouter}=require('../../src/routes/mysql/payments');const express=require('express'),f=fixture();let csrfAllowed=true;
    const app=express();app.use(express.json());app.use('/api/payments',createRouter({service:f.service,authenticate:(req,_res,next)=>{req.tokenDecode=actor;next();},csrf:(req,_res,next)=>{req.csrf={checked:csrfAllowed,contextType:'session'};next();}}));
    const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));}),base='http://127.0.0.1:'+server.address().port;
    const post=(path,body,origin='https://consumer.test')=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
    try{
        let response=await post('/api/payments/checkout-attempts',payload(),null);assert.equal(response.status,403);assert.equal(f.calls.length,0);
        csrfAllowed=false;response=await post('/api/payments/checkout-attempts',payload());assert.equal(response.status,403);assert.equal(f.calls.length,0);
        response=await post('/api/payments/subscription/cancel',{},null);assert.equal(response.status,403);
        response=await post('/api/payments/subscription/cancel',{});assert.equal(response.status,403);
        csrfAllowed=true;let cancellations=0;f.service.cancelSubscription=async(verified,body)=>{assert.deepEqual(verified,actor);cancellations++;return {subscription:{cancellation:{state:'scheduled'}},license:{active:true}};};
        response=await post('/api/payments/subscription/cancel',{});assert.equal(response.status,200);assert.equal(cancellations,1);assert.equal(response.headers.get('cache-control'),'no-store');
        csrfAllowed=true;response=await post('/api/payments/checkout-attempts',payload());assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.status,'ready');assert.equal(response.headers.get('cache-control'),'no-store');
        response=await post('/api/payments/legal/context',{subjectId:actor.id_login,organizationId:actor.id_business,purpose:'checkout_validation'},null);assert.equal(response.status,401);
        f.client.licenses.resolve=async()=>{throw new Error('secret-token upstream internal');};response=await fetch(base+'/api/payments/license');assert.equal(response.status,503);assert(!(await response.text()).includes('secret-token'));
    }finally{await new Promise(resolve=>server.close(resolve));}
});

function cancellationFixture() {
    const f=fixture(),end=new Date(Date.now()+86400000*20).toISOString();
    let current={organizationId:actor.id_business,productCode:'medsync',revision:'1',confirmedAt:new Date().toISOString(),
        license:{active:true,licenseStatus:'active',productCode:'medsync',subscriptionId:f.receipt.subscriptionId,planCode:'medsync_pro',validUntil:end,features:{},seatsLimit:4,usageLimit:null},
        subscription:{id:f.receipt.subscriptionId,organizationId:actor.id_business,productCode:'medsync',planCode:'medsync_pro',planPriceCode:'monthly',status:'active',currentPeriodEnd:end,nextBillingTime:end,cancelAtPeriodEnd:false,cancellation:null,pendingPlanChange:null}};
    f.client.snapshots.current=async()=>{f.calls.push(['snapshot']);return structuredClone(current);};
    f.client.subscriptions.cancel=async(id,input)=>{f.calls.push(['cancel',id,input]);current.revision='2';current.subscription={...current.subscription,status:'cancelled',cancelAtPeriodEnd:true,nextBillingTime:null,cancellation:{state:'scheduled',requestedAt:new Date().toISOString(),effectiveAt:end}};return current.subscription;};
    return {...f,body:{idempotencyKey:randomUUID(),expectedSubscriptionId:f.receipt.subscriptionId,expectedPeriodEnd:end},current:()=>current};
}
test('cancel binds the live administrator, synchronizes paid access and reconciles repeated intents without another mutation',async()=>{
    const f=cancellationFixture(),result=await f.service.cancelSubscription(actor,f.body);
    assert.equal(result.subscription.cancellation.state,'scheduled');assert.equal(result.license.active,true);
    assert.equal(result.license.validUntil,f.body.expectedPeriodEnd);
    assert.deepEqual(f.calls.find(c=>c[0]==='cancel'),['cancel',f.receipt.subscriptionId,{idempotencyKey:f.body.idempotencyKey,actorUserId:actor.id_login}]);
    assert.equal(f.calls.filter(c=>c[0]==='project').length,2);
    await f.service.cancelSubscription(actor,{...f.body,idempotencyKey:randomUUID()});
    f.current().subscription.cancellation.state='pending';
    assert.equal((await f.service.cancelSubscription(actor,f.body)).subscription.cancellation.state,'pending');
    assert.equal(f.calls.filter(c=>c[0]==='cancel').length,1);
});
test('cancel rejects tenant/actor overrides, changed subscription or period, expired and revoked licenses before mutation',async()=>{
    const f=cancellationFixture();
    for(const body of [{...f.body,actorUserId:randomUUID()},{...f.body,organizationId:randomUUID()},{...f.body,expectedPeriodEnd:'invalid'},{...f.body,expectedSubscriptionId:randomUUID()},{...f.body,expectedPeriodEnd:new Date(Date.now()+100000).toISOString()}])await assert.rejects(f.service.cancelSubscription(actor,body));
    await assert.rejects(f.service.cancelSubscription({...actor,id_business:randomUUID()},f.body),e=>e.status===403);
    f.setRow({...f.row(),rol:'doctor'});await assert.rejects(f.service.cancelSubscription(actor,f.body),e=>e.status===403);
    f.setRow({...f.row(),rol:'admin'});
    f.current().license.active=false;f.current().license.licenseStatus='revoked';await assert.rejects(f.service.cancelSubscription(actor,f.body),e=>e.code==='PAYMENT_CANCELLATION_UNAVAILABLE');
    f.current().license.active=true;f.current().license.licenseStatus='active';
    f.current().subscription.currentPeriodEnd=new Date(Date.now()-1000).toISOString();
    await assert.rejects(f.service.cancelSubscription(actor,{...f.body,expectedPeriodEnd:f.current().subscription.currentPeriodEnd}),e=>e.code==='PAYMENT_CANCELLATION_UNAVAILABLE');
    assert(!f.calls.some(c=>c[0]==='cancel'));
});
test('uncertain cancellation never retries a financial mutation or reports unpersisted success',async()=>{
    const f=cancellationFixture();f.client.subscriptions.cancel=async()=>{f.calls.push(['cancel']);throw new Error('private provider timeout');};
    await assert.rejects(f.service.cancelSubscription(actor,f.body),e=>e.status===503&&!e.message.includes('private'));
    assert.equal(f.calls.filter(c=>c[0]==='cancel').length,1);
    const g=cancellationFixture();let projects=0;g.projection.apply=async()=>{if(++projects===2)throw Error('db failed');};
    await assert.rejects(g.service.cancelSubscription(actor,g.body),e=>e.status===503);
    assert.equal(g.calls.filter(c=>c[0]==='cancel').length,1);
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {PaymentsError}=require('@hemia/payments');
const {PaymentsService}=require('../../src/services/payments/payments.service');

function fixture() {
    const actor={id_login:randomUUID(),id_business:randomUUID(),id_session:randomUUID()},calls=[],receipts=new Map(),payloads=new Map();
    let row={...actor,rol:'admin',email_verified:1,subscription_status:'active'},projectionFailure=false,getFailure=null,createFailure=null;
    const source={id:randomUUID(),organizationId:actor.id_business,productCode:'medsync',status:'active',planCode:'medsync_basic',planPriceCode:'basic_monthly',cancelAtPeriodEnd:false,cancellation:null};
    const quote={kind:'upgrade',amountDueNow:'125.50',currency:'MXN',effectiveAt:new Date().toISOString(),nextBillingAt:new Date(Date.now()+86400000*20).toISOString(),recurringAmount:'999.00'};
    const body={idempotencyKey:randomUUID(),expectedSubscriptionId:source.id,planCode:'medsync_pro',planPriceCode:'pro_monthly',expectedAmountDueNow:quote.amountDueNow,legalAcceptanceId:randomUUID()};
    const query={expectedSubscriptionId:source.id,targetPlanCode:body.planCode,targetPlanPriceCode:body.planPriceCode};
    const buyer={organizationId:actor.id_business,userId:actor.id_login};
    const client={
        subscriptions:{
            current:async org=>{calls.push(['subscription',org]);return structuredClone(source);},
            planChangeQuote:async(id,plan,price)=>{calls.push(['quote',id,plan,price]);return structuredClone(quote);}
        },
        attempts:{
            get:async(id,context)=>{
                calls.push(['get',id,context]);
                if(getFailure)throw getFailure;
                assert.deepEqual(context,buyer);
                if(!receipts.has(id))throw new PaymentsError('response',404);
                return structuredClone(receipts.get(id));
            },
            create:async input=>{
                calls.push(['create',structuredClone(input)]);
                if(createFailure)throw createFailure;
                if(payloads.has(input.idempotencyKey)) {
                    if(JSON.stringify(payloads.get(input.idempotencyKey))!==JSON.stringify(input))throw new PaymentsError('response',409);
                    return structuredClone(receipts.get(input.idempotencyKey));
                }
                payloads.set(input.idempotencyKey,structuredClone(input));
                const receipt={attemptId:input.idempotencyKey,operation:'change_plan',status:'ready',statusFresh:true,planCode:input.planCode,planPriceCode:input.planPriceCode,
                    checkoutId:randomUUID(),subscriptionId:source.id,checkoutUrl:'https://www.sandbox.paypal.com/revise',
                    planChange:{...quote,state:'awaiting_approval',action:'approve_subscription',checkoutUrl:'https://www.sandbox.paypal.com/revise'}};
                receipts.set(input.idempotencyKey,receipt);return structuredClone(receipt);
            },
            confirm:async(id,context)=>{calls.push(['confirm',id,context]);assert.deepEqual(context,buyer);return structuredClone(receipts.get(id));}
        },
        snapshots:{current:async org=>{calls.push(['snapshot',org]);return {organizationId:org,productCode:'medsync',revision:'2',license:{active:true}};}}
    };
    const db={query:async(sql,options)=>{
        assert.match(sql,/^SELECT/);
        if(!row||options.replacements.login!==actor.id_login||options.replacements.business!==actor.id_business||options.replacements.session!==actor.id_session)return [];
        return [row];
    }};
    const projection={apply:async snapshot=>{calls.push(['project',snapshot.organizationId]);if(projectionFailure)throw new Error('synthetic projection failure');return {applied:true};}};
    const runtime={config:{successUrl:'https://consumer.test/original-success',cancelUrl:'https://consumer.test/original-cancel',receiver:{audience:'medsync'},legal:{verificationClientId:'legal'}},client};
    const service=new PaymentsService(db,{runtime,projection});
    return {actor,buyer,service,client,source,body,query,quote,calls,receipts,payloads,row:()=>row,setRow:value=>{row=value;},failProjection:value=>{projectionFailure=value;},failGet:value=>{getFailure=value;},failCreate:value=>{createFailure=value;}};
}
const mutations=f=>f.calls.filter(call=>['create','confirm','cancel'].includes(call[0]));
async function cancellationFixture() {
    const f=fixture();await f.service.createPlanChangeAttempt(f.actor,f.body);
    const receipt=f.receipts.get(f.body.idempotencyKey);
    f.source.pendingPlanChange={...receipt.planChange,attemptId:receipt.attemptId,checkoutId:receipt.checkoutId,
        newSubscriptionId:receipt.subscriptionId,targetPlanCode:receipt.planCode,targetPlanPriceCode:receipt.planPriceCode};
    f.client.attempts.cancel=async(id,buyer)=>{
        f.calls.push(['cancel',id,buyer]);assert.equal(id,receipt.attemptId);assert.deepEqual(buyer,f.buyer);
        Object.assign(receipt,{status:'rejected',checkoutStatus:'cancelled',errorCode:'PAYMENT_ATTEMPT_CANCELLED',checkoutUrl:undefined});
        Object.assign(receipt.planChange,{state:'failed',action:'none',checkoutUrl:null});f.source.pendingPlanChange=null;
        return {cancelled:true};
    };
    f.calls.length=0;return f;
}

test('discard unapproved preparation verifies the owned canonical cancellation and leaves the paid subscription intact',async()=>{
    const f=await cancellationFixture(),id=f.body.idempotencyKey;
    assert.deepEqual(await f.service.cancelPlanChangeAttempt(f.actor,id,{}),{cancelled:true});
    assert.deepEqual(f.calls.map(c=>c[0]),['get','subscription','cancel','get','subscription']);
    assert.equal(f.source.status,'active');assert.equal(f.source.planCode,'medsync_basic');assert.equal(f.source.cancelAtPeriodEnd,false);
    assert.equal(f.receipts.size,1);f.calls.length=0;
    assert.deepEqual(await f.service.cancelPlanChangeAttempt(f.actor,id,{}),{cancelled:true});
    assert.deepEqual(f.calls.map(c=>c[0]),['get','get','subscription']);assert.equal(mutations(f).length,0);
});

test('discard refuses authorized stages and races in the current subscription before calling the provider',async()=>{
    for(const location of ['receipt','source'])for(const patch of [{state:'scheduled'},{state:'effective'},{action:'approve_payment'}]) {
        const f=await cancellationFixture();Object.assign(location==='receipt'?f.receipts.get(f.body.idempotencyKey).planChange:f.source.pendingPlanChange,patch);
        await assert.rejects(f.service.cancelPlanChangeAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code==='PLAN_CHANGE_ALREADY_AUTHORIZED'&&e.status===409);
        assert.equal(mutations(f).length,0);
    }
    for(const patch of [{status:'processing'},{status:'pending'},{status:'rejected'},{statusFresh:false},{operation:'checkout'},{abandoned:true},{planChange:null}]) {
        const f=await cancellationFixture();Object.assign(f.receipts.get(f.body.idempotencyKey),patch);
        await assert.rejects(f.service.cancelPlanChangeAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code==='PAYMENT_CONFLICT');assert.equal(mutations(f).length,0);
    }
    for(const patch of [{checkoutId:randomUUID()},{newSubscriptionId:randomUUID()},{attemptId:randomUUID()},{targetPlanCode:'different'},{targetPlanPriceCode:'different'}]) {
        const f=await cancellationFixture();Object.assign(f.source.pendingPlanChange,patch);
        await assert.rejects(f.service.cancelPlanChangeAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code==='PAYMENT_CONFLICT');assert.equal(mutations(f).length,0);
    }
});

test('discard preserves a refused or pending rollback and only exposes a safe PayPal approval URL',async()=>{
    for(const result of [{cancelled:false},{cancelled:false,approvalUrl:'https://www.sandbox.paypal.com/restore?token=synthetic'},{cancelled:false,approvalUrl:'https://www.paypal.com/restore'}]) {
        const f=await cancellationFixture();f.client.attempts.cancel=async(id,buyer)=>{f.calls.push(['cancel',id,buyer]);return result;};
        assert.deepEqual(await f.service.cancelPlanChangeAttempt(f.actor,f.body.idempotencyKey,{}),result);
        assert.equal(f.receipts.get(f.body.idempotencyKey).status,'ready');assert.ok(f.source.pendingPlanChange);
        assert.deepEqual(f.calls.map(c=>c[0]),['get','subscription','cancel']);
    }
    for(const result of [null,{},[],{cancelled:1},{cancelled:true,abandoned:true},{cancelled:true,approvalUrl:'https://www.paypal.com/restore'},
        ...['http://www.paypal.com/restore','https://evil.test/restore','https://www.paypal.com.evil.test/restore','https://user@www.paypal.com/restore','https://www.paypal.com:444/restore','https://www.paypal.com\\@evil.test/restore',null].map(approvalUrl=>({cancelled:false,approvalUrl}))]) {
        const f=await cancellationFixture();f.client.attempts.cancel=async()=>result;
        await assert.rejects(f.service.cancelPlanChangeAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code==='BILLING_UNAVAILABLE');
        assert.equal(f.receipts.get(f.body.idempotencyKey).status,'ready');
    }
});

test('discard fails closed on unknown outcomes, leases, and missing canonical proof without a blind retry',async()=>{
    for(const error of [Error('unknown provider secret'),new PaymentsError('response',409)]) {
        const f=await cancellationFixture();f.client.attempts.cancel=async(id,buyer)=>{f.calls.push(['cancel',id,buyer]);throw error;};
        await assert.rejects(f.service.cancelPlanChangeAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code===(error.status===409?'PAYMENT_CONFLICT':'BILLING_UNAVAILABLE'));
        assert.equal(mutations(f).length,1);assert.equal(f.receipts.get(f.body.idempotencyKey).status,'ready');
    }
    for(const mode of ['ready','wrong-id','pending','new-pending']) {
        const f=await cancellationFixture(),cancel=f.client.attempts.cancel;
        f.client.attempts.cancel=async(id,buyer)=>{
            if(mode==='ready')return {cancelled:true};
            const result=await cancel(id,buyer);
            if(mode==='wrong-id')f.receipts.get(id).checkoutId=randomUUID();
            if(mode==='pending'||mode==='new-pending')f.source.pendingPlanChange={state:'awaiting_approval',attemptId:mode==='pending'?id:randomUUID()};
            return result;
        };
        await assert.rejects(f.service.cancelPlanChangeAttempt(f.actor,f.body.idempotencyKey,{}),e=>['BILLING_UNAVAILABLE','PAYMENT_CONFLICT'].includes(e.code));
        assert.equal(f.calls.filter(c=>c[0]==='cancel').length,mode==='ready'?0:1);
    }
    const f=await cancellationFixture();f.failGet(new PaymentsError('response',404));
    await assert.rejects(f.service.cancelPlanChangeAttempt(f.actor,randomUUID(),{}),e=>e.code==='PAYMENT_NOT_FOUND');assert.equal(mutations(f).length,0);
});

test('discard requires verified native admin and exact empty body, with buyer ownership supplied to the SDK',async()=>{
    const f=await cancellationFixture(),id=f.body.idempotencyKey;
    for(const body of [undefined,null,[],{organizationId:randomUUID()},{paid:false}])await assert.rejects(f.service.cancelPlanChangeAttempt(f.actor,id,body),e=>e.status===400);
    await assert.rejects(f.service.cancelPlanChangeAttempt({...f.actor,id_business:randomUUID()},id,{}),e=>e.status===403);
    await assert.rejects(f.service.cancelPlanChangeAttempt({...f.actor,id_login:randomUUID()},id,{}),e=>e.status===403);
    f.setRow({...f.row(),rol:'doctor'});await assert.rejects(f.service.cancelPlanChangeAttempt(f.actor,id,{}),e=>e.status===403);
    f.setRow({...f.row(),rol:'admin',email_verified:0});await assert.rejects(f.service.cancelPlanChangeAttempt(f.actor,id,{}),e=>e.code==='CONTACT_VERIFICATION_REQUIRED');
    assert.equal(f.calls.length,0);
});

test('quote is read-only, binds current native tenant/source, and passes Billing decimal/date values unchanged',async()=>{
    const f=fixture();assert.deepEqual(await f.service.planChangeQuote(f.actor,f.query),f.quote);
    assert.deepEqual(f.calls,[['subscription',f.actor.id_business],['quote',f.source.id,f.body.planCode,f.body.planPriceCode]]);
    assert.equal(mutations(f).length,0);
    await assert.rejects(f.service.planChangeQuote(f.actor,{...f.query,expectedSubscriptionId:randomUUID()}),e=>e.code==='PAYMENT_CONFLICT');
    f.source.organizationId=randomUUID();await assert.rejects(f.service.planChangeQuote(f.actor,f.query),e=>e.code==='BILLING_UNAVAILABLE');
    f.source.organizationId=f.actor.id_business;f.source.productCode='other';await assert.rejects(f.service.planChangeQuote(f.actor,f.query),e=>e.code==='BILLING_UNAVAILABLE');
    assert.equal(f.calls.filter(c=>c[0]==='quote').length,1);
});

test('change plan injects operation/buyer, freezes quoted money and consent, and fixes its own callback path',async()=>{
    const f=fixture(),receipt=await f.service.createPlanChangeAttempt(f.actor,f.body),sent=f.payloads.get(f.body.idempotencyKey);
    assert.equal(receipt.operation,'change_plan');assert.equal(receipt.attemptId,f.body.idempotencyKey);
    assert.deepEqual({...sent,successUrl:undefined,cancelUrl:undefined},{...f.body,...f.buyer,operation:'change_plan',successUrl:undefined,cancelUrl:undefined});
    for(const [field,result]of [['successUrl','approved'],['cancelUrl','cancelled']]) {
        const url=new URL(sent[field]);assert.equal(url.origin,'https://consumer.test');assert.equal(url.pathname,'/cuenta/cambiar-plan');
        assert.equal(url.searchParams.get('attempt_id'),f.body.idempotencyKey);assert.equal(url.searchParams.get('result'),result);
    }
    assert.deepEqual(f.calls.map(c=>c[0]),['get','subscription','create']);
    assert.equal(f.calls.filter(c=>c[0]==='confirm').length,0);
});

test('replaying an existing change keeps its exact ID and immutable payload after the source changes',async()=>{
    const f=fixture();const first=await f.service.createPlanChangeAttempt(f.actor,f.body);
    f.source.id=randomUUID();f.source.status='cancelled';f.source.cancelAtPeriodEnd=true;
    assert.deepEqual(await f.service.createPlanChangeAttempt(f.actor,f.body),first);
    assert.equal(f.receipts.size,1);assert.equal(f.calls.filter(c=>c[0]==='subscription').length,1);
    await assert.rejects(f.service.createPlanChangeAttempt(f.actor,{...f.body,expectedAmountDueNow:'999.00'}),e=>e.code==='PAYMENT_CONFLICT');
    await assert.rejects(f.service.createPlanChangeAttempt(f.actor,{...f.body,legalAcceptanceId:randomUUID()}),e=>e.code==='PAYMENT_CONFLICT');
    assert.equal(f.receipts.size,1);assert.equal(f.calls.filter(c=>c[0]==='confirm').length,0);
});

test('unknown receipt reads, changed source and changed Billing quote never initiate another operation',async()=>{
    const f=fixture();f.failGet(new Error('unknown transport outcome'));
    await assert.rejects(f.service.createPlanChangeAttempt(f.actor,f.body),e=>e.code==='BILLING_UNAVAILABLE');assert.equal(mutations(f).length,0);
    f.failGet(null);f.source.id=randomUUID();await assert.rejects(f.service.createPlanChangeAttempt(f.actor,f.body),e=>e.code==='PAYMENT_CONFLICT');assert.equal(mutations(f).length,0);
    f.source.id=f.body.expectedSubscriptionId;f.failCreate(new PaymentsError('response',409));
    await assert.rejects(f.service.createPlanChangeAttempt(f.actor,f.body),e=>e.code==='PAYMENT_CONFLICT');
    assert.equal(mutations(f).length,1);assert.equal(f.calls.find(c=>c[0]==='create')[1].expectedAmountDueNow,'125.50');assert.equal(f.receipts.size,0);
});

test('admin/native membership, email verification and exact body fields protect both mutations',async()=>{
    const f=fixture();
    for(const field of ['organizationId','userId','provider','operation','checkoutId','successUrl','currency','paidAmount'])
        await assert.rejects(f.service.createPlanChangeAttempt(f.actor,{...f.body,[field]:'untrusted'}),e=>e.status===400);
    for(const amount of [125.5,'1e2','-1.00','1.001',null])await assert.rejects(f.service.createPlanChangeAttempt(f.actor,{...f.body,expectedAmountDueNow:amount}),e=>e.status===400);
    for(const field of ['idempotencyKey','expectedSubscriptionId'])for(const value of [[f.body[field]],{},null,13])await assert.rejects(f.service.createPlanChangeAttempt(f.actor,{...f.body,[field]:value}),e=>e.status===400);
    await assert.rejects(f.service.createPlanChangeAttempt(f.actor,{...f.body,legalAcceptanceId:[f.body.legalAcceptanceId]}),e=>e.code==='PAYMENT_LEGAL_ACCEPTANCE_REQUIRED');
    await assert.rejects(f.service.planChangeQuote(f.actor,{...f.query,organizationId:randomUUID()}),e=>e.status===400);
    await assert.rejects(f.service.createPlanChangeAttempt({...f.actor,id_business:randomUUID()},f.body),e=>e.status===403);
    f.setRow({...f.row(),rol:'doctor'});await assert.rejects(f.service.planChangeQuote(f.actor,f.query),e=>e.status===403);
    await assert.rejects(f.service.createPlanChangeAttempt(f.actor,f.body),e=>e.status===403);
    await assert.rejects(f.service.confirmAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.status===403);
    f.setRow({...f.row(),rol:'admin',email_verified:0});await assert.rejects(f.service.createPlanChangeAttempt(f.actor,f.body),e=>e.code==='CONTACT_VERIFICATION_REQUIRED');
    await assert.rejects(f.service.confirmAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code==='CONTACT_VERIFICATION_REQUIRED');
    assert.equal(f.calls.length,0);
});

test('downgrade preserves Billing zero amount and scheduled boundary without inventing an immediate charge',async()=>{
    const f=fixture();Object.assign(f.quote,{kind:'downgrade',amountDueNow:'0.00',effectiveAt:f.quote.nextBillingAt,recurringAmount:'499.00'});f.body.expectedAmountDueNow='0.00';
    assert.deepEqual(await f.service.planChangeQuote(f.actor,f.query),f.quote);
    const receipt=await f.service.createPlanChangeAttempt(f.actor,f.body);
    assert.equal(receipt.planChange.kind,'downgrade');assert.equal(receipt.planChange.amountDueNow,'0.00');assert.equal(receipt.planChange.effectiveAt,f.quote.nextBillingAt);
    assert.equal(f.calls.filter(c=>c[0]==='confirm').length,0);
});

test('malformed receipt reads and ineligible new sources fail closed before a financial operation',async()=>{
    for(const sourcePatch of [{status:'pending'},{status:'cancelled'},{cancelAtPeriodEnd:true},{cancellation:{state:'pending'}}]) {
        const f=fixture();Object.assign(f.source,sourcePatch);
        await assert.rejects(f.service.createPlanChangeAttempt(f.actor,f.body),e=>e.code==='PAYMENT_CONFLICT');assert.equal(mutations(f).length,0);
    }
    const f=fixture();f.client.attempts.get=async()=>null;
    await assert.rejects(f.service.createPlanChangeAttempt(f.actor,f.body),e=>e.code==='BILLING_UNAVAILABLE');assert.equal(mutations(f).length,0);
});

test('confirm only uses the owned change attempt, then synchronizes projection and returns the same canonical receipt',async()=>{
    const f=fixture();await f.service.createPlanChangeAttempt(f.actor,f.body);f.calls.length=0;
    const receipt=await f.service.confirmAttempt(f.actor,f.body.idempotencyKey,{});
    assert.equal(receipt.attemptId,f.body.idempotencyKey);assert.deepEqual(f.calls.map(c=>c[0]),['get','confirm','snapshot','project','get']);
    assert.deepEqual(f.calls.find(c=>c[0]==='confirm'),['confirm',f.body.idempotencyKey,f.buyer]);
    await assert.rejects(f.service.confirmAttempt(f.actor,f.body.idempotencyKey,{checkoutId:randomUUID(),paid:true}),e=>e.status===400);
    f.failGet(new PaymentsError('response',404));const before=mutations(f).length;
    await assert.rejects(f.service.confirmAttempt(f.actor,randomUUID(),{}),e=>e.code==='PAYMENT_NOT_FOUND');assert.equal(mutations(f).length,before);
    f.failGet(null);f.receipts.get(f.body.idempotencyKey).operation='checkout';
    await assert.rejects(f.service.confirmAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code==='PAYMENT_CONFLICT');assert.equal(mutations(f).length,before);
});

test('scheduled/effective state remains authoritative; projection failure recovers the same attempt without creation',async()=>{
    for(const state of ['scheduled','effective']) {
        const f=fixture();await f.service.createPlanChangeAttempt(f.actor,f.body);
        Object.assign(f.receipts.get(f.body.idempotencyKey).planChange,{state,action:'none',checkoutUrl:null});f.failProjection(true);
        await assert.rejects(f.service.confirmAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code==='BILLING_UNAVAILABLE');
        f.failProjection(false);const receipt=await f.service.confirmAttempt(f.actor,f.body.idempotencyKey,{});
        assert.equal(receipt.planChange.state,state);assert.equal(receipt.planChange.action,'none');
        assert.equal(f.receipts.size,1);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
        for(const call of f.calls.filter(c=>c[0]==='confirm'))assert.equal(call[1],f.body.idempotencyKey);
    }
});

test('confirm refuses pending/rejected/abandoned and never projects an inconsistent confirmation',async()=>{
    const f=fixture();await f.service.createPlanChangeAttempt(f.actor,f.body);const receipt=f.receipts.get(f.body.idempotencyKey);
    for(const status of ['pending','processing','rejected']) {
        receipt.status=status;await assert.rejects(f.service.confirmAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code==='PAYMENT_CONFLICT');
    }
    receipt.status='ready';receipt.abandoned=true;await assert.rejects(f.service.confirmAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code==='PAYMENT_CONFLICT');
    assert.equal(f.calls.filter(c=>c[0]==='confirm').length,0);receipt.abandoned=false;
    f.client.attempts.confirm=async()=>({...receipt,subscriptionId:randomUUID()});
    await assert.rejects(f.service.confirmAttempt(f.actor,f.body.idempotencyKey,{}),e=>e.code==='BILLING_UNAVAILABLE');assert.equal(f.calls.filter(c=>c[0]==='project').length,0);
});

test('HTTP quote/change/confirm/cancel preserve session Origin/CSRF and sanitize remote failures',async()=>{
    process.env.CSRF_ALLOWED_ORIGINS='https://consumer.test';
    const path=require.resolve('../../src/db/Sequelize.connection');require.cache[path]={id:path,filename:path,loaded:true,exports:{query:async()=>{throw Error('No real DB permitted');}}};
    const {createRouter}=require('../../src/routes/mysql/payments'),express=require('express'),f=fixture();let csrfAllowed=true,contextType='session';
    const app=express();app.use(express.json());app.use('/api/payments',createRouter({service:f.service,authenticate:(req,_res,next)=>{req.tokenDecode=f.actor;next();},csrf:(req,_res,next)=>{req.csrf={checked:csrfAllowed,contextType};next();}}));
    const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));}),base='http://127.0.0.1:'+server.address().port;
    const post=(path,body,origin='https://consumer.test')=>fetch(base+'/api/payments'+path,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
    try {
        const quoteResponse=await fetch(base+'/api/payments/subscription/plan-change-quote?'+new URLSearchParams(f.query));assert.equal(quoteResponse.status,200);assert.deepEqual(await quoteResponse.json(),f.quote);assert.equal(quoteResponse.headers.get('cache-control'),'no-store');
        for(const [path,body]of [['/subscription/change-plan',f.body],['/checkout-attempts/'+f.body.idempotencyKey+'/confirm',{}],['/checkout-attempts/'+f.body.idempotencyKey+'/cancel',{}]]) {
            for(const origin of [null,'https://evil.test'])assert.equal((await post(path,body,origin)).status,403);
            csrfAllowed=false;assert.equal((await post(path,body)).status,403);csrfAllowed=true;contextType='machine';assert.equal((await post(path,body)).status,403);contextType='session';
        }
        assert.equal(mutations(f).length,0);
        let response=await post('/subscription/change-plan',f.body);assert.equal(response.status,200);assert.equal((await response.json()).operation,'change_plan');
        response=await post('/checkout-attempts/'+f.body.idempotencyKey+'/confirm',{});assert.equal(response.status,200);assert.equal((await response.json()).attemptId,f.body.idempotencyKey);
        const cancelPath='/checkout-attempts/'+f.body.idempotencyKey+'/cancel',receipt=f.receipts.get(f.body.idempotencyKey);
        response=await post(cancelPath,{organizationId:randomUUID()});assert.equal(response.status,400);
        receipt.planChange.state='scheduled';response=await post(cancelPath,{});assert.equal(response.status,409);assert.equal((await response.json()).code,'PLAN_CHANGE_ALREADY_AUTHORIZED');receipt.planChange.state='awaiting_approval';
        f.source.pendingPlanChange={...receipt.planChange,attemptId:receipt.attemptId,checkoutId:receipt.checkoutId,newSubscriptionId:receipt.subscriptionId,targetPlanCode:receipt.planCode,targetPlanPriceCode:receipt.planPriceCode};
        f.client.attempts.cancel=async()=>{throw Error('private OAuth provider credentials');};
        response=await post(cancelPath,{});assert.equal(response.status,503);assert.ok(!(await response.text()).includes('credentials'));
        f.client.attempts.cancel=async()=>({cancelled:false,approvalUrl:'https://www.paypal.com/restore'});
        response=await post(cancelPath,{});assert.equal(response.status,200);assert.deepEqual(await response.json(),{cancelled:false,approvalUrl:'https://www.paypal.com/restore'});
        f.client.attempts.cancel=async()=>{
            Object.assign(receipt,{status:'rejected',checkoutStatus:'cancelled',errorCode:'PAYMENT_ATTEMPT_CANCELLED'});
            Object.assign(receipt.planChange,{state:'failed',action:'none',checkoutUrl:null});f.source.pendingPlanChange=null;return {cancelled:true};
        };
        response=await post(cancelPath,{});assert.equal(response.status,200);assert.deepEqual(await response.json(),{cancelled:true});
        response=await post(cancelPath,{});assert.equal(response.status,200);assert.deepEqual(await response.json(),{cancelled:true});
        Object.assign(receipt,{status:'ready',checkoutStatus:'pending',errorCode:undefined});
        f.client.attempts.confirm=async()=>{throw Error('private OAuth provider credentials');};
        response=await post('/checkout-attempts/'+f.body.idempotencyKey+'/confirm',{});assert.equal(response.status,503);assert.ok(!(await response.text()).includes('credentials'));
    }finally{await new Promise(resolve=>server.close(resolve));}
});

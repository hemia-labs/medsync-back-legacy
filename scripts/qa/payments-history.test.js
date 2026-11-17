'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {PaymentsError}=require('@hemia/payments');
const {PaymentsService}=require('../../src/services/payments/payments.service');

function fixture() {
    const actor={id_login:randomUUID(),id_business:randomUUID(),id_session:randomUUID()},calls=[];
    let row={...actor,rol:'admin',email_verified:1,subscription_status:'active'},failure=null;
    let page={items:[{id:randomUUID(),organizationId:actor.id_business,productCode:'medsync',subscriptionId:randomUUID(),provider:'paypal',
        status:'paid',amount:'499.00',currency:'MXN',paidAt:'2026-11-16T10:00:00.000Z',createdAt:'2026-11-16T10:00:01.000Z',reference:'PAYPAL-TRANSACTION'}],nextCursor:null};
    const db={query:async(sql,options)=>{
        assert.match(sql,/^SELECT/);assert.match(sql,/JOIN `session`/);
        const expected=options.replacements;
        return row&&expected.login===actor.id_login&&expected.business===actor.id_business&&expected.session===actor.id_session?[row]:[];
    }};
    const service=new PaymentsService(db,{runtime:{client:{payments:{list:async(...input)=>{
        calls.push(input);if(failure)throw failure;return structuredClone(page);
    }}}}});
    return {actor,service,calls,page:()=>page,setPage:value=>{page=value;},setRow:value=>{row=value;},row:()=>row,fail:value=>{failure=value;}};
}

test('history derives the clinic from the authenticated administrator and reads paid records across subscriptions',async()=>{
    const f=fixture();
    f.page().items.push({...f.page().items[0],id:randomUUID(),subscriptionId:randomUUID(),amount:'125.50',description:'Prorrateo por cambio de plan'});
    const page=await f.service.history(f.actor,{});
    assert.equal(page.items.length,2);assert.notEqual(page.items[0].subscriptionId,page.items[1].subscriptionId);
    assert.deepEqual(f.calls,[[f.actor.id_business,{}]]);
    f.page().nextCursor='opaque_cursor';await f.service.history(f.actor,{cursor:'opaque_cursor'});
    assert.deepEqual(f.calls.at(-1),[f.actor.id_business,{cursor:'opaque_cursor'}]);
    assert.equal(page.items[0].amount,'499.00','History displays the settled amount, not the current plan price');
});

test('history rejects browser organization, product, subscription, provider and pagination overrides',async()=>{
    const f=fixture();
    for(const input of [{organizationId:randomUUID()},{organization_id:randomUUID()},{productCode:'other'},{product_code:'other'},
        {subscriptionId:randomUUID()},{provider:'paypal'},{limit:'1000'},{userId:randomUUID()},[],null,
        {cursor:''},{cursor:[]},{cursor:{}},{cursor:123},{cursor:'a'.repeat(2049)},{cursor:'abc/def'},{cursor:'../payments'}]) {
        await assert.rejects(f.service.history(f.actor,input),error=>error.status===400&&error.code==='INVALID_PAYMENT_REQUEST');
    }
    assert.equal(f.calls.length,0);
});

test('history requires a live native administrator session even when the browser supplies another clinic',async()=>{
    const f=fixture();
    await assert.rejects(f.service.history({...f.actor,id_business:randomUUID()}),error=>error.status===403);
    await assert.rejects(f.service.history({...f.actor,id_session:randomUUID()}),error=>error.status===403);
    for(const rol of ['staff','doctor','assistant','super_admin']) {
        f.setRow({...f.row(),rol});await assert.rejects(f.service.history(f.actor),error=>error.status===403);
    }
    f.setRow(null);await assert.rejects(f.service.history(f.actor),error=>error.status===403);
    await assert.rejects(f.service.history({}),error=>error.status===401);
    assert.equal(f.calls.length,0);
});

test('history does not require another checkout consent, a verified purchase proof or an active subscription',async()=>{
    const f=fixture();f.setRow({...f.row(),email_verified:0,subscription_status:'cancelled'});
    assert.equal((await f.service.history(f.actor)).items.length,1);
    f.setRow({...f.row(),subscription_status:'pending_activation'});
    await assert.rejects(f.service.history(f.actor),error=>error.status===403);
});

test('history rejects unscoped, unpaid and malformed SDK results before exposing any row',async()=>{
    const f=fixture(),original=structuredClone(f.page());
    for(const patch of [{organizationId:randomUUID()},{productCode:'another-product'},{provider:'another-provider'},{status:'pending'},{status:'failed'}]) {
        f.setPage({...original,items:[{...original.items[0],...patch}]});
        await assert.rejects(f.service.history(f.actor),error=>error.code==='BILLING_UNAVAILABLE'&&error.status===503);
    }
    for(const page of [null,{}, {items:[],nextCursor:42},{items:[],nextCursor:'https://evil.test'},
        {items:Array(26).fill(original.items[0]),nextCursor:null}]) {
        f.setPage(page);await assert.rejects(f.service.history(f.actor),error=>error.status===503);
    }
    for(const status of ['paid','partially_refunded','refunded','reversed']) {
        f.setPage({...original,items:[{...original.items[0],status}]});assert.equal((await f.service.history(f.actor)).items[0].status,status);
    }
    f.setPage({items:[],nextCursor:null});assert.deepEqual(await f.service.history(f.actor),{items:[],nextCursor:null});
});

test('upstream history authentication and service failures do not log out the user or expose credentials',async()=>{
    const f=fixture();
    for(const error of [new PaymentsError('authentication',401),Error('private OAuth credential failure')]) {
        f.fail(error);await assert.rejects(f.service.history(f.actor),failure=>failure.code==='BILLING_UNAVAILABLE'&&failure.status===503&&!failure.message.includes('private'));
    }
});

test('history HTTP is read-only, authenticated, non-cacheable and never trusts clinic query parameters',async()=>{
    const express=require('express'),{createRouter}=require('../../src/routes/mysql/payments'),f=fixture();
    const app=express();let authenticated=true,csrfCalls=0;
    app.use('/api/payments',createRouter({service:f.service,authenticate:(req,res,next)=>{
        if(!authenticated)return res.status(401).json({code:'AUTH_REQUIRED'});
        req.tokenDecode=f.actor;next();
    },csrf:()=>{csrfCalls++;throw Error('A history GET cannot mutate');}}));
    const server=await new Promise(resolve=>{const running=app.listen(0,'127.0.0.1',()=>resolve(running));});
    const base='http://127.0.0.1:'+server.address().port+'/api/payments/history';
    try {
        let response=await fetch(base);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
        assert.deepEqual(await response.json(),f.page());assert.equal(csrfCalls,0);
        response=await fetch(base+'?organizationId='+randomUUID());assert.equal(response.status,400);assert.equal(f.calls.length,1);
        authenticated=false;response=await fetch(base);assert.equal(response.status,401);assert.equal(f.calls.length,1);
    } finally {await new Promise(resolve=>server.close(resolve));}
});

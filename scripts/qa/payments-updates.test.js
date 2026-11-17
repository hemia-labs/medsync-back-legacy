'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PaymentUpdates,paymentUpdates}=require('../../src/services/payments/paymentUpdates.service');
function connection(updates,business='business-a',authorize=async()=>{},expiresAt=Date.now()+60000,snapshot) {
    const req=new EventEmitter(),res=new EventEmitter();let text='',ended=false;
    res.set=()=>{};res.flushHeaders=()=>{};res.write=value=>{text+=value;};res.end=()=>{ended=true;res.emit('close');};
    const close=updates.open(req,res,{business,expiresAt,authorize,snapshot});
    return {req,res,close,text:()=>text,ended:()=>ended};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('updates isolate businesses, contain no financial payload, and remove closed listeners',async()=>{
    const updates=new PaymentUpdates(),one=connection(updates),two=connection(updates,'business-b');
    try {
        await flush();assert.equal(one.text(),'event: updated\ndata: {}\n\n');
        updates.publish('business-a');await flush();assert.equal(one.text().match(/updated/g).length,2);assert.equal(two.text().match(/updated/g).length,1);
        one.req.emit('aborted');updates.publish('business-a');await flush();assert.equal(one.text().match(/updated/g).length,2);assert.equal(updates.total,1);
    }finally{one.close();two.close();}assert.equal(updates.total,0);assert.equal(updates.listeners.size,0);
});
test('expired/revoked sessions and bounded streams close without renewal or reconnect',async()=>{
    const updates=new PaymentUpdates();assert.throws(()=>connection(updates,'a',async()=>{},Date.now()-1),error=>error.status===401);
    let allowed=true;const one=connection(updates,'a',async()=>{if(!allowed)throw Error('revoked');});await flush();
    allowed=false;updates.publish('a');await flush();assert.equal(one.ended(),true);assert.match(one.text(),/event: settled/);assert.equal(updates.total,0);
    const short=connection(updates,'b',async()=>{},Date.now()+20);await new Promise(resolve=>setTimeout(resolve,35));assert.equal(short.ended(),true);assert.equal(updates.total,0);
});
test('live updates are capped and queued notifications never overlap authorization checks',async()=>{
    const updates=new PaymentUpdates(),connections=Array.from({length:4},()=>connection(updates));
    try{assert.throws(()=>connection(updates),error=>error.status===503);}finally{connections.forEach(item=>item.close());}
    let release,active=0,maximum=0;const one=connection(updates,'queued',async()=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>{release=resolve;});active--;});
    updates.publish('queued');updates.publish('queued');release();await flush();release();await flush();assert.equal(maximum,1);assert.equal(one.text().match(/updated/g).length,2);one.close();
});
test('real HTTP stream flushes an initial update and a webhook notice, then closes cleanly',async()=>{
    const express=require('express'),updates=new PaymentUpdates(),app=express();let close;
    app.get('/events',(req,res)=>{close=updates.open(req,res,{business:'a',expiresAt:Date.now()+60000,authorize:async()=>{}});});
    const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
    try {
        const response=await fetch('http://127.0.0.1:'+server.address().port+'/events');
        assert.match(response.headers.get('content-type'),/text\/event-stream/);assert.equal(response.headers.get('x-accel-buffering'),'no');
        const reader=response.body.getReader(),decode=value=>Buffer.from(value).toString();
        assert.match(decode((await reader.read()).value),/event: updated\ndata: {}/);
        updates.publish('a');assert.match(decode((await reader.read()).value),/event: updated/);
        close();assert.match(decode((await reader.read()).value),/event: settled/);assert.equal((await reader.read()).done,true);
        assert.equal(updates.total,0);
    }finally{if(close)close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('verified SDK webhooks push committed current snapshots, including reconciliation races; rollback never notifies',async()=>{
    const {PaymentsService}=require('../../src/services/payments/payments.service');let receiver,applied=true,fail=false,current=null;
    const updates=[];const original=paymentUpdates.publish;paymentUpdates.publish=(id,snapshot)=>updates.push({id,snapshot});
    try {
        const sdk={createPaymentsClient:()=>({}),createPaymentsReceiver:(_config,hooks)=>{receiver=hooks;return {};}};
        const service=new PaymentsService({},{sdk,env:{HEMIA_CLIENT_ID:'test',HEMIA_CLIENT_SECRET:'synthetic',PAYMENTS_CONNECTION:JSON.stringify({productCode:'medsync',clientId:'test'})},projection:{apply:async()=>{if(fail)throw Error('rollback');return {applied};}}});
        service.currentSnapshot=async()=>current;
        const snapshot={organizationId:'business-a',revision:'2'};
        service.runtime();await receiver.onSnapshot(snapshot);assert.deepEqual(updates,[{id:'business-a',snapshot}]);
        applied=false;await receiver.onSnapshot(snapshot);assert.equal(updates.length,1);
        current={...snapshot,revision:'3'};await receiver.onSnapshot(snapshot);assert.equal(updates.length,2);assert.equal(updates[1].snapshot,current,'A late webhook pushes the newer locally committed state, never its obsolete payload');
        current=snapshot;await receiver.onSnapshot(snapshot);assert.equal(updates.length,3,'A webhook still pushes a revision already committed by reconciliation');
        fail=true;await assert.rejects(receiver.onSnapshot(snapshot));assert.equal(updates.length,3);
    }finally{paymentUpdates.publish=original;}
});
test('HTTP stream requires allowed Origin, owned attempt and an authenticated current buyer',async()=>{
    process.env.CSRF_ALLOWED_ORIGINS='https://consumer.test';
    const path=require.resolve('../../src/db/Sequelize.connection');require.cache[path]={id:path,filename:path,loaded:true,exports:{query:async()=>{throw Error('No real DB');}}};
    const express=require('express'),{createRouter}=require('../../src/routes/mysql/payments');let allow=true,opened=0,authenticated=true;
    const service={getAttempt:async()=>{if(!allow){const {RegistrationError}=require('../../src/services/registration/errors');throw new RegistrationError('PAYMENT_NOT_FOUND',404);}return {};},context:async()=>({})};
    const app=express();app.use('/api/payments',createRouter({service,authenticate:(req,res,next)=>{if(!authenticated)return res.status(401).end();req.tokenDecode={id_business:'business-a',exp:Math.floor(Date.now()/1000)+600};next();},updates:{open:(_req,res,context)=>{opened++;assert.equal(context.business,'business-a');res.json({stream:true});}}}));
    const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));}),url='http://127.0.0.1:'+server.address().port+'/api/payments/checkout-attempts/test/events';
    try {
        assert.equal((await fetch(url)).status,403);assert.equal((await fetch(url,{headers:{Origin:'https://evil.test'}})).status,403);assert.equal(opened,0);
        allow=false;assert.equal((await fetch(url,{headers:{Origin:'https://consumer.test'}})).status,404);assert.equal(opened,0);
        allow=true;assert.equal((await fetch(url,{headers:{Origin:'https://consumer.test'}})).status,200);assert.equal(opened,1);
        authenticated=false;assert.equal((await fetch(url,{headers:{Origin:'https://consumer.test'}})).status,401);assert.equal(opened,1);
    }finally{await new Promise(resolve=>server.close(resolve));}
});

test('subscription stream pushes payloads without rereads, serializes authorization and isolates businesses',async()=>{
    const updates=new PaymentUpdates();let reads=0,release,block=false;
    const initial={organizationId:'a',revision:'1',license:{active:true}},refund={organizationId:'a',revision:'3',license:{active:false,billing:{refundConfirmation:{status:'completed'}}}};
    const one=connection(updates,'a',async()=>{if(block)await new Promise(resolve=>{release=resolve;});},Date.now()+120000,async()=>{reads++;return initial;});
    const two=connection(updates,'b',async()=>{},Date.now()+120000,async()=>null);
    try {
        await flush();assert.match(one.text(),/id: 1\nevent: snapshot/);assert.match(two.text(),/event: ready/);assert.equal(reads,1);
        block=true;updates.publish('a',{...initial,revision:'2'});updates.publish('a',refund);release();await flush();release();await flush();
        const messages=one.text().split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
        assert.deepEqual(messages,[initial,{...initial,revision:'2'},refund]);assert.equal(reads,1,'No local or central fetch for a webhook push');
        assert.equal(two.text(),'event: ready\ndata: {}\n\n','No cross-tenant payload');
        assert.equal(one.ended(),false,'Subscription stream remains open after publishing');
    }finally{one.close();two.close();}
});
test('cached subscription snapshot is parsed and bound to the authenticated business without central calls',async()=>{
    const {PaymentsService}=require('../../src/services/payments/payments.service'),{randomUUID}=require('node:crypto');
    const organizationId=randomUUID(),subscriptionId=randomUUID(),end=new Date(Date.now()+86400000).toISOString();
    const snapshot={organizationId,productCode:'medsync',revision:'1',confirmedAt:new Date().toISOString(),
        license:{active:true,productCode:'medsync',planCode:'medsync_pro',licenseStatus:'active',validUntil:end,subscriptionId,seatsLimit:1,usageLimit:null,features:{}},
        subscription:{id:subscriptionId,organizationId,productCode:'medsync',planCode:'medsync_pro',planPriceCode:'monthly',status:'active',cancelAtPeriodEnd:false,currentPeriodEnd:end,nextBillingTime:end,cancellation:null,pendingPlanChange:null}};
    let saved=snapshot,queries=0;
    const service=new PaymentsService({query:async(sql,options)=>{queries++;assert.equal(options.replacements.business,organizationId);return [{billing_snapshot:saved&&JSON.stringify(saved)}];}});
    service.context=async()=>({organizationId});service.runtime=()=>{throw Error('Must not call Billing from the stream');};
    assert.equal((await service.savedSubscriptionSnapshot({})).revision,'1');assert.equal(queries,1);
    saved={...snapshot,organizationId:randomUUID()};await assert.rejects(service.savedSubscriptionSnapshot({}));
    saved=null;assert.equal(await service.savedSubscriptionSnapshot({}),null);
});
test('checkout recovery HTTP reads only the authenticated saved snapshot, including an empty state',async()=>{
    const express=require('express'),{createRouter}=require('../../src/routes/mysql/payments'),{PaymentsService}=require('../../src/services/payments/payments.service'),{RegistrationError}=require('../../src/services/registration/errors');
    let authenticated=true,admin=true,reads=0;
    const actor={id_business:'owned-business'},saved={organizationId:actor.id_business,revision:'7'};
    const service=new PaymentsService({});
    service.context=async verified=>{assert.equal(verified,actor);if(!admin)throw new RegistrationError('PAYMENTS_FORBIDDEN',403);return {organizationId:actor.id_business};};
    service.currentSnapshot=async business=>{assert.equal(business,actor.id_business);reads++;return reads===1?saved:null;};
    service.runtime=()=>{throw Error('Recovery must not request Billing or PayPal');};
    const app=express();app.use('/api/payments',createRouter({service,authenticate:(req,res,next)=>{if(!authenticated)return res.status(401).end();req.tokenDecode=actor;next();}}));
    const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));}),url='http://127.0.0.1:'+server.address().port+'/api/payments/subscription/snapshot';
    try {
        authenticated=false;assert.equal((await fetch(url)).status,401);assert.equal(reads,0);
        authenticated=true;admin=false;assert.equal((await fetch(url)).status,403);assert.equal(reads,0);
        admin=true;const response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),saved);
        assert.equal(await (await fetch(url)).json(),null);assert.equal(reads,2);
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('real subscription HTTP stream sends cached then webhook state on one request with origin and admin authorization',async()=>{
    process.env.CSRF_ALLOWED_ORIGINS='https://consumer.test';
    const express=require('express'),{createRouter}=require('../../src/routes/mysql/payments'),{RegistrationError}=require('../../src/services/registration/errors');
    const updates=new PaymentUpdates();let admin=true,authenticated=true,reads=0,requests=0;
    const service={context:async()=>{if(!admin)throw new RegistrationError('PAYMENTS_FORBIDDEN',403);return {organizationId:'a'};},savedSubscriptionSnapshot:async()=>{reads++;return {organizationId:'a',revision:'1'};}};
    const app=express();app.use((req,res,next)=>{requests++;next();});app.use('/api/payments',createRouter({service,authenticate:(req,res,next)=>{if(!authenticated)return res.status(401).end();req.tokenDecode={id_business:'a',exp:Math.floor(Date.now()/1000)+600};next();},updates}));
    const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));}),url='http://127.0.0.1:'+server.address().port+'/api/payments/subscription/events';
    let reader;
    try {
        assert.equal((await fetch(url,{headers:{Origin:'https://evil.test'}})).status,403);
        admin=false;assert.equal((await fetch(url,{headers:{Origin:'https://consumer.test'}})).status,403);
        admin=true;authenticated=false;assert.equal((await fetch(url,{headers:{Origin:'https://consumer.test'}})).status,401);
        authenticated=true;const response=await fetch(url,{headers:{Referer:'https://consumer.test/admin?section=plan-billing'}});reader=response.body.getReader();
        assert.match(Buffer.from((await reader.read()).value).toString(),/id: 1\nevent: snapshot/);const count=requests;
        updates.publish('a',{organizationId:'a',revision:'2',license:{active:false,billing:{refundConfirmation:{status:'completed'}}}});
        const pushed=Buffer.from((await reader.read()).value).toString();assert.match(pushed,/id: 2\nevent: snapshot/);assert.match(pushed,/refundConfirmation/);assert.equal(reads,1);assert.equal(requests,count,'No browser request/reload after webhook');
        admin=false;updates.publish('a',{revision:'3'});assert.match(Buffer.from((await reader.read()).value).toString(),/event: settled/);assert.equal((await reader.read()).done,true);assert.equal(updates.total,0);
    }finally{if(reader)await reader.cancel();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

'use strict';
// Read-only development check: never prepares consent or creates/verifies/retries a payment.
require('../../src/config/config');
const assert=require('node:assert/strict');
const {createPaymentsClient,createPaymentsLegalClient,createPaymentsReceiver}=require('@hemia/payments');
const scopes=['billing.integration.catalog.read','billing.integration.checkout.create','billing.integration.checkout.read','billing.integration.licenses.read','billing.subscriptions.manage'];
async function check() {
    assert.equal(process.env.NODE_ENV,'development','This check only targets local development');
    const connection=JSON.parse(process.env.PAYMENTS_CONNECTION||'null');
    assert.equal(connection?.productCode,'medsync');
    assert.equal(connection.clientId,process.env.HEMIA_CLIENT_ID);
    assert(process.env.HEMIA_CLIENT_SECRET,'Backend OAuth credentials are missing');
    for(const target of ['baseUrl','issuer','tokenUrl','resource','successUrl','cancelUrl'].map(key=>connection[key])
        .concat([connection.legal?.baseUrl,connection.legal?.resource])) {
        const url=new URL(target);
        assert.equal(url.protocol,'http:');
        assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Only loopback targets are allowed');
        assert(!url.username&&!url.password);
    }
    assert(connection.allowHttpLoopback===true);
    const config={...connection,clientSecret:process.env.HEMIA_CLIENT_SECRET};
    const client=createPaymentsClient(config);
    assert.equal(typeof client.payments?.list,'function','The installed payments SDK must support payment history');
    await client.verifyCompatibility();
    const plans=await client.catalog.listPlans();
    assert(plans.length&&plans.every(plan=>plan.code.startsWith('medsync_')&&plan.prices.length));
    assert(connection.legal?.verificationClientId&&connection.receiver?.audience,'Legal callback configuration is missing');
    createPaymentsLegalClient(config);createPaymentsReceiver(config);
    for(const url of [new URL('/api/v1/health/ready',connection.baseUrl),new URL('/health/ready',connection.legal.baseUrl)]) {
        const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000),cache:'no-store'});
        assert(response.ok,'A local dependency is not ready');await response.body?.cancel();
    }
    // Verify all needed service grants without submitting a financial operation.
    const response=await fetch(connection.tokenUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
        headers:{'content-type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'client_credentials',client_id:connection.clientId,client_secret:process.env.HEMIA_CLIENT_SECRET,
            resource:connection.resource,audience:connection.audience,scope:scopes.join(' ')})});
    assert(response.ok,'MedSync checkout OAuth grants are not configured');
    const token=await response.json();assert(typeof token.scope==='string'&&scopes.every(scope=>token.scope.split(/\s+/).includes(scope)));
    console.log(JSON.stringify({result:'PASS',sdk:'@hemia/payments',target:'local',compatible:true,checkoutGrants:true,paymentHistoryAvailable:true,
        plans:plans.map(plan=>({code:plan.code,priceCodes:plan.prices.map(price=>price.code)})),legalCallbackConfigured:true,
        purchasesCreated:0,acceptancesCreated:0}));
}
check().catch(()=>{console.error('Payments local preflight failed. Check local services, PAYMENTS_CONNECTION and the MedSync OAuth policy; no payment was submitted.');process.exitCode=1;});

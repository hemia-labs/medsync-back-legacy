'use strict';
const axios=require('axios');
const {RegistrationError}=require('./errors');
const CATALOG_URL='https://billing.hemia.cloud/api/v1/billing/catalog/plans';
let cached=null,expiresAt=0,pending=null;
const unavailable=()=>({available:false,offers:[],reason:'catalog_unavailable',planId:'professional',trialDays:15,checkoutAvailable:false});
function catalog(data) {
    if(data?.productCode!=='medsync'||!Array.isArray(data.plans)||!data.plans.length||data.plans.length>20) throw Error('INVALID_CATALOG');
    const codes=new Set();
    const offers=data.plans.map(plan=>{
        if(!/^medsync_[a-z0-9_]{1,60}$/.test(plan.code)||codes.has(plan.code)||typeof plan.name!=='string'||!plan.name.trim()||plan.name.length>200
            || !Array.isArray(plan.prices)||!plan.prices.length||plan.prices.length>10
            || !plan.features||typeof plan.features!=='object'||Array.isArray(plan.features)||Object.keys(plan.features).length>100) throw Error('INVALID_PLAN');
        codes.add(plan.code);
        const prices=plan.prices.map(price=>{
            if(typeof price.code!=='string'||!/^[a-z0-9_]{1,100}$/.test(price.code)
                ||typeof price.amount!=='string'||!/^\d{1,12}\.\d{2}$/.test(price.amount)
                ||!/^[A-Z]{3}$/.test(price.currency)||!['month','year'].includes(price.billingInterval)
                ||!Number.isInteger(price.billingIntervalCount)||price.billingIntervalCount<1||price.billingIntervalCount>120) throw Error('INVALID_PRICE');
            return {code:price.code,amount:price.amount,currency:price.currency,billingInterval:price.billingInterval,billingIntervalCount:price.billingIntervalCount};
        });
        const features={};
        for(const [code,value] of Object.entries(plan.features)) {
            if(!/^[a-z][a-z0-9_.]{0,100}$/.test(code)||(typeof value!=='boolean'&&!(Number.isInteger(value)&&value>=0))) throw Error('INVALID_FEATURE');
            features[code]=value;
        }
        return {code:plan.code,name:plan.name,prices,features};
    });
    // IVA treatment confirmed by the product owner; Billing supplies the prices.
    return {available:true,offers,planId:'professional',trialDays:15,taxBehavior:'inclusive',checkoutAvailable:false};
}
module.exports={
    async plans() {
        if(cached&&Date.now()<expiresAt) return cached;
        if(pending) return pending;
        pending=(async()=>{
            try {
                const result=await axios.get(CATALOG_URL,{params:{product_code:'medsync'},timeout:5000,maxRedirects:0,maxContentLength:262144});
                cached=catalog(result.data);expiresAt=Date.now()+60000;
            } catch(_) {cached=unavailable();expiresAt=Date.now()+10000;}
            return cached;
        })();
        try{return await pending;}finally{pending=null;}
    },
    async checkout() {throw new RegistrationError('BILLING_UNAVAILABLE',503);}
};

'use strict';
// R5 replaces this server-side boundary. No provider credentials or simulated
// license transitions are exposed to the browser.
const {RegistrationError}=require('./errors');
module.exports={
    async plans() { return {available:false,offers:[],reason:'provider_unavailable',planId:'professional'}; },
    async checkout() { throw new RegistrationError('BILLING_UNAVAILABLE',503); }
};

'use strict';
const {configuredPayments}=require('../payments/payments.service');
module.exports={plans:()=>configuredPayments().plans(),checkout:(actor,body)=>configuredPayments().createAttempt(actor,body)};

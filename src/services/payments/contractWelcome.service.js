'use strict';
const {QueryTypes}=require('sequelize');
const {validate:uuid}=require('uuid');
const {parsePaymentSnapshot}=require('@hemia/payments');
const {isEmailUrl}=require('../email/emailUrls');
const {commercialState}=require('./paidLicense');

const PLAN_NAMES={medsync_basic:'Básico',medsync_pro:'Profesional',medsync_clinic:'Clínica'};
const clean=value=>String(value||'').replace(/[\x00-\x1f\x7f]+/g,' ').trim();
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)>0;
const money=value=>typeof value==='string'&&/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value);
const dates=new Intl.DateTimeFormat('es-MX',{dateStyle:'long',timeZone:'America/Mexico_City'});

function confirmedPurchase(snapshot) {
    const c=snapshot.license.billing?.checkoutConfirmation,sub=snapshot.subscription;
    if(!c||typeof c!=='object'||!sub||sub.status!=='active'||snapshot.license.licenseStatus!=='active'
        ||commercialState(snapshot).status!=='active'||!PLAN_NAMES[sub.planCode]
        ||c.status!=='completed'||c.provider!=='paypal'||c.productCode!=='medsync'
        ||c.organizationId!==snapshot.organizationId||c.subscriptionId!==sub.id
        ||c.planCode!==sub.planCode||c.planPriceCode!==sub.planPriceCode
        ||![c.paymentId,c.userId,c.subscriptionId,c.organizationId].every(value=>typeof value==='string'&&uuid(value))
        ||!money(c.recurringAmount)||!money(c.paidAmount)||Number(c.paidAmount)<=0
        ||typeof c.currency!=='string'||!/^[A-Z]{3}$/.test(c.currency)
        ||!['month','year'].includes(c.billingInterval)||!Number.isInteger(c.billingIntervalCount)
        ||c.billingIntervalCount<1||c.billingIntervalCount>120
        ||!date(c.paidAt)||Date.parse(c.paidAt)>Date.parse(snapshot.confirmedAt)+300000
        ||!(c.nextBillingAt===null||date(c.nextBillingAt)))return null;
    return {organizationId:c.organizationId,productCode:'medsync',subscriptionId:c.subscriptionId,
        paymentId:c.paymentId,userId:c.userId,status:'completed',provider:'paypal',planCode:c.planCode,
        planPriceCode:c.planPriceCode,planName:clean(c.planName)||PLAN_NAMES[c.planCode],
        recurringAmount:c.recurringAmount,paidAmount:c.paidAmount,currency:c.currency,
        billingInterval:c.billingInterval,billingIntervalCount:c.billingIntervalCount,
        paidAt:c.paidAt,nextBillingAt:c.nextBillingAt};
}

async function enqueueContractWelcome(db,snapshot,transaction) {
    const purchase=confirmedPurchase(snapshot);
    if(!purchase)return false;
    await db.query(`INSERT INTO payments_welcome_outbox(subscription_id,id_business,id_login,payment_id,payload,created_at)
        VALUES(:subscription,:business,:login,:payment,:payload,UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE subscription_id=subscription_id`,
    {replacements:{subscription:purchase.subscriptionId,business:purchase.organizationId,login:purchase.userId,
        payment:purchase.paymentId,payload:JSON.stringify(purchase)},type:QueryTypes.INSERT,transaction});
    return true;
}

function welcomeVariables(purchase,snapshot,account,loginUrl) {
    const amount=value=>new Intl.NumberFormat('es-MX',{style:'currency',currency:purchase.currency,
        currencyDisplay:'narrowSymbol',minimumFractionDigits:Number.isInteger(Number(value))?0:2,maximumFractionDigits:2}).format(Number(value))+' '+purchase.currency;
    const interval=purchase.billingInterval==='month'?'mes':'año';
    const billingIntervalLabel=purchase.billingIntervalCount===1?interval
        :`${purchase.billingIntervalCount} ${purchase.billingInterval==='month'?'meses':'años'}`;
    const variables={firstName:clean(account.first_name)||clean(account.name).split(/\s+/)[0]||'equipo',
        clinicName:clean(account.clinic_name)||'tu consultorio',planName:purchase.planName,
        amountLabel:amount(purchase.recurringAmount),billingIntervalLabel,paidAmountLabel:amount(purchase.paidAmount),
        paymentMethodLabel:'PayPal',activatedAtLabel:dates.format(new Date(purchase.paidAt)),loginUrl};
    const sub=snapshot.subscription;
    if(!sub.cancelAtPeriodEnd&&!sub.cancellation&&purchase.nextBillingAt&&Date.parse(purchase.nextBillingAt)>Date.now()
        &&sub.nextBillingTime&&Date.parse(sub.nextBillingTime)===Date.parse(purchase.nextBillingAt)) {
        variables.nextBillingAtLabel=dates.format(new Date(purchase.nextBillingAt));
        variables.renewalNotice=`Tu suscripción se renueva cada ${billingIntervalLabel}. Puedes consultar sus detalles en MedSync.`;
    }
    return variables;
}

async function sendNextContractWelcome(db,loginUrl,send=message=>require('../email/email.service').sendTransactionalEmail(message)) {
    if(!isEmailUrl(loginUrl,{allowLocalApp:true}))throw Error('PAYMENTS_WELCOME_URL_INVALID');
    const claimed=await db.transaction(async transaction=>{
        const [event]=await db.query(`SELECT subscription_id,id_business,id_login,payment_id,payload FROM payments_welcome_outbox
            WHERE claimed_at IS NULL OR (error_code='EMAIL_DELIVERY_RETRYABLE' AND sent_at IS NULL
                AND claimed_at<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE))
            ORDER BY created_at,subscription_id LIMIT 1 FOR UPDATE`,{type:QueryTypes.SELECT,transaction});
        if(!event)return null;
        const [account]=await db.query(`SELECT l.email,l.first_name,l.name,b.name AS clinic_name,b.billing_snapshot,b.billing_revision
            FROM login l JOIN business b ON b.id_business=l.id_business
            JOIN rol r ON r.id_rol=l.id_rol AND r.active=1 AND r.code='admin'
            JOIN auth_identity i ON i.id_login=l.id_login AND i.kind='email' AND i.normalized_value=l.email
            WHERE l.id_login=:login AND l.id_business=:business AND l.active=1 AND l.locked=0
                AND b.active=1 AND b.status='active' AND b.subscription_status='active'
                AND i.reservation_status='verified' AND i.verified_at IS NOT NULL AND i.expires_at IS NULL LIMIT 1`,
        {replacements:{login:event.id_login,business:event.id_business},type:QueryTypes.SELECT,transaction});
        let variables;
        if(account) {
            const snapshot=parsePaymentSnapshot(typeof account.billing_snapshot==='string'?JSON.parse(account.billing_snapshot):account.billing_snapshot,'medsync',event.id_business);
            const purchase=confirmedPurchase(snapshot),saved=typeof event.payload==='string'?JSON.parse(event.payload):event.payload;
            if(purchase&&snapshot.revision===String(account.billing_revision)&&purchase.subscriptionId===event.subscription_id
                &&purchase.userId===event.id_login&&purchase.paymentId===event.payment_id
                &&saved.subscriptionId===event.subscription_id&&saved.organizationId===event.id_business
                &&saved.userId===event.id_login&&saved.paymentId===event.payment_id)
                variables=welcomeVariables(saved,snapshot,account,loginUrl);
        }
        // SES has no send idempotency key. Commit the claim before the external call; never resend an uncertain delivery.
        const [,changed]=await db.query(`UPDATE payments_welcome_outbox SET claimed_at=UTC_TIMESTAMP(3),error_code=:error
            WHERE subscription_id=:subscription AND (claimed_at IS NULL OR (error_code='EMAIL_DELIVERY_RETRYABLE'
                AND sent_at IS NULL AND claimed_at<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE)))`,
        {replacements:{subscription:event.subscription_id,error:variables?null:'RECIPIENT_OR_CONTRACT_UNAVAILABLE'},type:QueryTypes.UPDATE,transaction});
        if(changed!==1)throw Error('PAYMENTS_WELCOME_NOT_CLAIMED');
        return {subscriptionId:event.subscription_id,to:account?.email,variables};
    });
    if(!claimed)return false;
    if(!claimed.variables)return true;
    let sent=false,retryable=false;
    try {
        const result=await send({type:'subscription-welcome',to:claimed.to,variables:claimed.variables});
        sent=result?.success===true;retryable=!sent&&result?.retryable===true;
    }
    catch(_) { /* A lost acknowledgement must not create a second delivery. */ }
    if(retryable) {
        await db.query(`UPDATE payments_welcome_outbox SET error_code='EMAIL_DELIVERY_RETRYABLE'
            WHERE subscription_id=:subscription AND claimed_at IS NOT NULL AND sent_at IS NULL`,
        {replacements:{subscription:claimed.subscriptionId},type:QueryTypes.UPDATE});
        console.warn('[PAYMENTS_WELCOME_RETRY_PENDING]',{subscriptionId:claimed.subscriptionId});
        return true;
    }
    await db.query(`UPDATE payments_welcome_outbox SET sent_at=${sent?'UTC_TIMESTAMP(3)':'NULL'},error_code=:error
        WHERE subscription_id=:subscription AND claimed_at IS NOT NULL`,
    {replacements:{subscription:claimed.subscriptionId,error:sent?null:'EMAIL_DELIVERY_UNCONFIRMED'},type:QueryTypes.UPDATE});
    if(!sent)console.warn('[PAYMENTS_WELCOME_UNCONFIRMED]',{subscriptionId:claimed.subscriptionId});
    return true;
}

function startContractWelcomeJob(db) {
    const email=require('../email/email.service');
    if(!process.env.PAYMENTS_CONNECTION||email.providerName()!=='ses'||!process.env.EMAIL_REGISTRATION_WELCOME_TEMPLATE)return null;
    let loginUrl;
    try {if(!isEmailUrl(process.env.PUBLIC_APP_URL,{allowLocalApp:true}))throw Error();loginUrl=new URL('/login',process.env.PUBLIC_APP_URL).href;}
    catch(_) {console.warn('[PAYMENTS_WELCOME_URL_INVALID]');return null;}
    let running=false;
    const tick=async()=>{if(running||!email.initialize().success)return;running=true;
        try {for(let i=0;i<5;i++)if(!await sendNextContractWelcome(db,loginUrl))break;}
        catch(_) {console.warn('[PAYMENTS_WELCOME_JOB_FAILED]');}
        finally {running=false;}};
    const timer=setInterval(tick,15000);timer.unref();tick();return timer;
}
module.exports={confirmedPurchase,enqueueContractWelcome,welcomeVariables,sendNextContractWelcome,startContractWelcomeJob};

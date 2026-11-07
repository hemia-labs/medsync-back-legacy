'use strict';

const {QueryTypes}=require('sequelize');
const email=require('../email/email.service');
const {isEmailUrl}=require('../email/emailUrls');

const dateFormat=new Intl.DateTimeFormat('es-MX',{dateStyle:'long',timeZone:'UTC'});
const durationFormat=new Intl.NumberFormat('es-MX',{style:'unit',unit:'day',unitDisplay:'long'});
const clean=value=>String(value||'').replace(/[\x00-\x1f\x7f]+/g,' ').trim();

async function sendNextWelcome(db,loginUrl,send=message=>email.sendTransactionalEmail(message)) {
    // Claim before calling SES. Its SendEmail API has no idempotency key for an ambiguous response.
    const claimed=await db.transaction(async transaction=>{
        const [event]=await db.query(`SELECT event_id FROM registration_outbox
            WHERE event_type='registration.trial_welcome' AND processed_at IS NULL
            ORDER BY created_at,event_id LIMIT 1 FOR UPDATE`,{type:QueryTypes.SELECT,transaction});
        if(!event)return null;
        const eventId=event.event_id;
        const [account]=await db.query(`SELECT l.email,l.first_name,l.name,b.name AS clinic_name,
            TIMESTAMPDIFF(DAY,b.trial_starts_at,b.trial_ends_at) AS trial_days,
            DATE_FORMAT(b.trial_ends_at,'%Y-%m-%d') AS trial_end_date
            FROM registration_outbox o JOIN login l ON l.id_login=o.id_login AND l.id_business=o.id_business
            JOIN business b ON b.id_business=o.id_business
            JOIN registration_account a ON a.id_login=l.id_login AND a.id_business=b.id_business
            JOIN auth_identity i ON i.id_login=l.id_login AND i.kind='email' AND i.normalized_value=l.email
            WHERE o.event_id=:id AND l.active=1 AND b.active=1 AND b.status='active'
                AND b.subscription_status='trial' AND b.plan='pro' AND b.trial_ends_at>NOW()
                AND b.trial_ends_at>=DATE_ADD(b.trial_starts_at,INTERVAL 1 DAY)
                AND a.activation_completed_at IS NOT NULL
                AND i.reservation_status='verified' AND i.verified_at IS NOT NULL AND i.expires_at IS NULL`,
        {replacements:{id:eventId},type:QueryTypes.SELECT,transaction});
        await db.query('UPDATE registration_outbox SET processed_at=UTC_TIMESTAMP(3) WHERE event_id=:id',
            {replacements:{id:eventId},type:QueryTypes.UPDATE,transaction});
        return {eventId,account};
    });
    if(!claimed)return false;
    const {eventId,account}=claimed;
    if(!account)return true;

    const result=await send({type:'registration-welcome',to:account.email,variables:{
        firstName:clean(account.first_name)||clean(account.name).split(/\s+/)[0],
        clinicName:clean(account.clinic_name)||'tu consultorio',
        trialDurationLabel:durationFormat.format(account.trial_days),
        trialEndsAtLabel:dateFormat.format(new Date(account.trial_end_date+'T12:00:00Z')),
        loginUrl
    }});
    if(!result?.success)console.warn('[REGISTRATION_WELCOME_UNCONFIRMED]',{eventId});
    return true;
}

function startRegistrationWelcomeJob(db) {
    if(email.providerName()!=='ses'||!process.env.EMAIL_REGISTRATION_WELCOME_TEMPLATE)return null;
    let loginUrl;
    try {
        const app=process.env.PUBLIC_APP_URL;
        if(!isEmailUrl(app,{allowLocalApp:true}))throw Error();
        loginUrl=new URL('/login',app).href;
    } catch(_) {
        console.warn('[REGISTRATION_WELCOME_URL_INVALID]');
        return null;
    }
    let running=false;
    const tick=async()=>{
        if(running||!email.initialize().success)return;
        running=true;
        try {
            for(let i=0;i<5;i++)if(!await sendNextWelcome(db,loginUrl))break;
        } catch(_) {console.warn('[REGISTRATION_WELCOME_JOB_FAILED]');}
        finally {running=false;}
    };
    const timer=setInterval(tick,15000);timer.unref();tick();return timer;
}

module.exports={sendNextWelcome,startRegistrationWelcomeJob};

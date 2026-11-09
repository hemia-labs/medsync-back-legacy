'use strict';
const {QueryTypes}=require('sequelize');
const {v5:uuid}=require('uuid');
const {RegistrationError}=require('./errors');
const {exact}=require('./registrationSecurity');
const commercial=require('./commercialAdapter');
const {isBusinessOperational}=require('../../util/businessOperational');
const {getSaasPlan}=require('../../config/saasPlans');
// Email verification now activates self-registration, including its trial.
const enabled=()=>process.env.REGISTRATION_IDENTITY_ENABLED==='true';
function isActivationConfirmed(row) {
    const plan=getSaasPlan(row.plan);
    return row.active===1 && row.status==='active' && isBusinessOperational(row).allowed
        && (row.subscription_status==='active' ? Boolean(plan) : row.subscription_status==='trial' && plan?.code==='pro')
        && Boolean(row.activation_completed_at) && Boolean(row.email_verified);
}
class AccountActivationService {
    constructor(db,preparation) {
        this.db=db;
        this.preparation=preparation || ((business,login)=>require('../../Dao/mysql/preparation.dao').current(business,login));
    }
    query(sql,replacements,transaction) {return this.db.query(sql,{replacements,transaction,type:/^\s*SELECT/i.test(sql)?QueryTypes.SELECT:QueryTypes.RAW});}
    async activateVerifiedEmail(idLogin,transaction) {
        if(!transaction) throw new Error('ACTIVATION_TRANSACTION_REQUIRED');
        const [account]=await this.query(`SELECT l.id_login,l.id_business
            FROM login l JOIN business b ON b.id_business=l.id_business
            JOIN rol r ON r.id_rol=l.id_rol
            JOIN auth_identity i ON i.id_login=l.id_login AND i.kind='email' AND i.normalized_value=l.email
            LEFT JOIN registration_account a ON a.id_login=l.id_login AND a.id_business=l.id_business
            WHERE l.id_login=:login AND l.active=1 AND b.active=1 AND b.status='active'
                AND r.active=1 AND r.code='admin' AND l.created_by=l.id_login AND b.created_by=l.id_login
                AND b.subscription_status='pending_activation' AND b.trial_starts_at IS NULL AND b.trial_ends_at IS NULL
                AND a.activation_completed_at IS NULL
                AND i.reservation_status='verified' AND i.verified_at IS NOT NULL AND i.expires_at IS NULL
            LIMIT 1 FOR UPDATE`,{login:idLogin},transaction);
        if(!account) return false;
        await this.query(`UPDATE business SET subscription_status='trial',plan='pro',
            trial_starts_at=NOW(),trial_ends_at=DATE_ADD(NOW(),INTERVAL 15 DAY)
            WHERE id_business=:business AND subscription_status='pending_activation'`,
        {business:account.id_business},transaction);
        await this.query(`INSERT INTO registration_account(id_login,id_business,activation_completed_at)
            VALUES (:login,:business,NOW(3)) ON DUPLICATE KEY UPDATE
            activation_completed_at=COALESCE(activation_completed_at,VALUES(activation_completed_at))`,
        {login:account.id_login,business:account.id_business},transaction);
        const eventId=uuid('medsync:trial-welcome:'+account.id_business,uuid.URL);
        await this.query(`INSERT INTO registration_outbox(event_id,attempt_id,event_type,id_login,id_business,created_at)
            VALUES(:eventId,:eventId,'registration.trial_welcome',:login,:business,UTC_TIMESTAMP(3))
            ON DUPLICATE KEY UPDATE event_id=event_id`,
        {eventId,login:account.id_login,business:account.id_business},transaction);
        return true;
    }
    async account(actor,transaction) {
        if(!enabled() || !actor?.id_login || !actor?.id_business) throw new RegistrationError('ACTIVATION_FORBIDDEN',403);
        const [row]=await this.query(`SELECT a.*,b.subscription_status,b.status,b.active,b.plan,b.trial_starts_at,b.trial_ends_at,
            EXISTS(SELECT 1 FROM auth_identity i WHERE i.kind='email' AND i.normalized_value=l.email
                AND i.id_login=l.id_login AND i.reservation_status='verified' AND i.verified_at IS NOT NULL AND i.expires_at IS NULL) email_verified
            FROM registration_account a JOIN login l ON l.id_login=a.id_login AND l.id_business=a.id_business
            JOIN business b ON b.id_business=a.id_business JOIN rol r ON r.id_rol=l.id_rol
            WHERE a.id_login=:login AND a.id_business=:business AND l.active=1 AND r.active=1 AND r.code='admin'
            LIMIT 1${transaction?' FOR UPDATE':''}`,{login:actor.id_login,business:actor.id_business},transaction);
        if(!row) throw new RegistrationError('ACTIVATION_FORBIDDEN',403);
        return row;
    }
    confirmed(row) {return isActivationConfirmed(row);}
    async status(actor) {
        const row=await this.account(actor);
        const result={accountId:row.id_login,businessId:row.id_business,subscriptionStatus:row.subscription_status,
            contact:{telephoneVerified:false,emailVerified:Boolean(row.email_verified),requiredChannels:['email']},
            commercialState:'unavailable',nextAction:'unavailable',welcomePending:!row.setup_welcome_acknowledged_at,
            activationCompletedAt:row.activation_completed_at,setupWelcomeAcknowledgedAt:row.setup_welcome_acknowledged_at,
            destination:null,planId:getSaasPlan(row.plan)?.code||'professional',trialStartsAt:row.trial_starts_at,trialEndsAt:row.trial_ends_at};
        if(row.active!==1 || row.status!=='active' || !['pending_activation','trial','active'].includes(row.subscription_status)
            || (row.subscription_status==='trial' && !isBusinessOperational(row).allowed)) {
            return {...result,nextAction:'restricted',destination:'restricted'};
        }
        if(!row.email_verified) return {...result,nextAction:'verify_contacts'};
        if(!this.confirmed(row)) return {...result,nextAction:row.subscription_status==='active'?'wait_confirmation':'unavailable'};
        result.commercialState='activated';
        if(!result.welcomePending) return {...result,nextAction:'home',destination:'home'};
        const preparation=await this.preparation(row.id_business,row.id_login);
        const data=preparation?.data;
        // The internal legacy DAO returns {status,data}; HTTP clients add
        // success later. Do not mistake a successful DAO read for an outage.
        const preparationSucceeded=preparation?.success===true
            || (preparation?.success===undefined && preparation?.status===200);
        // Empty/failed readiness is unknown, never "0 of 0 complete".
        if(!preparationSucceeded || !Array.isArray(data?.steps) || !data.steps.length
            || !data.steps.every(step=>typeof step.ready==='boolean')) {
            return {...result,nextAction:'retry_preparation'};
        }
        return data.steps.some(step=>!step.ready) ? {...result,nextAction:'setup_summary',destination:'summary'}
            : {...result,nextAction:'home',destination:'home'};
    }
    async plans(actor) {await this.account(actor);return commercial.plans();}
    async checkout(actor) {
        const account=await this.account(actor);
        if(!account.email_verified) throw new RegistrationError('CONTACT_VERIFICATION_REQUIRED',409);
        return commercial.checkout();
    }
    async acknowledge(actor,body) {
        exact(body,['acknowledged']);
        if(body.acknowledged!==true) throw new RegistrationError('INVALID_REGISTRATION',400);
        const tx=await this.db.transaction();
        try {
            const row=await this.account(actor,tx);
            if(!this.confirmed(row)) throw new RegistrationError('ACTIVATION_REQUIRED',409);
            await this.query(`UPDATE registration_account SET setup_welcome_acknowledged_at=COALESCE(setup_welcome_acknowledged_at,NOW(3))
                WHERE id_login=:login AND id_business=:business`,{login:row.id_login,business:row.id_business},tx);
            const [saved]=await this.query('SELECT setup_welcome_acknowledged_at FROM registration_account WHERE id_login=:login AND id_business=:business',
                {login:row.id_login,business:row.id_business},tx);
            await tx.commit();return {acknowledged:true,acknowledgedAt:saved.setup_welcome_acknowledged_at};
        } catch(error) {if(!tx.finished)await tx.rollback();throw error;}
    }
}
module.exports={AccountActivationService,enabled,isActivationConfirmed};

'use strict';
const { randomUUID, randomInt } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { RegistrationError } = require('./errors');
const { mac, equal, exact } = require('./registrationSecurity');
const { normalizeEmail } = require('./identity');
const { RegistrationRateLimit } = require('./registrationRateLimit');
const { AccountActivationService } = require('./accountActivation.service');
const kinds = {sms:'phone',email:'email'};
const columns = {sms:'telephone',email:'email'};
class ContactVerificationService {
    constructor(db, delivery, preparation) {
        this.db=db; this.delivery=delivery; this.limiter=new RegistrationRateLimit(db);
        this.activation=new AccountActivationService(db,preparation);
    }
    query(sql,replacements,transaction) { return this.db.query(sql,{replacements,transaction,type:/^\s*SELECT\b/i.test(sql)?QueryTypes.SELECT:QueryTypes.RAW}); }
    async transaction(work) {
        const tx=await this.db.transaction();
        try { const result=await work(tx);await tx.commit();return result; }
        catch(error) { if(!tx.finished) await tx.rollback();throw error; }
    }
    async account(actor,tx) {
        if (!actor?.id_login || !actor?.id_business) throw new RegistrationError('ACTIVATION_FORBIDDEN',403);
        const [row]=await this.query(`SELECT l.id_login,l.id_business,l.telephone,l.email,b.subscription_status
            FROM login l JOIN business b ON b.id_business=l.id_business JOIN rol r ON r.id_rol=l.id_rol
            WHERE l.id_login=:login AND l.id_business=:business AND l.active=1 AND b.active=1 AND b.status='active'
                AND b.subscription_status IN ('pending_activation','trial','active') AND r.code='admin' AND r.active=1
                AND l.created_by=l.id_login AND b.created_by=l.id_login
            LIMIT 1${tx?' FOR UPDATE':''}`, {login:actor.id_login,business:actor.id_business},tx);
        if(!row) throw new RegistrationError('ACTIVATION_FORBIDDEN',403);
        return row;
    }
    async identity(account,channel,tx) {
        if(!account[columns[channel]]) return null;
        const [row]=await this.query(`SELECT *,expires_at<=NOW(3) expired FROM auth_identity
            WHERE kind=:kind AND normalized_value=:value${tx?' FOR UPDATE':''}`,
        {kind:kinds[channel],value:account[columns[channel]]},tx);
        return row && row.id_login===account.id_login ? row : null;
    }
    async status(actor) {
        const account=await this.account(actor), phone=await this.identity(account,'sms'), email=await this.identity(account,'email');
        if(account.subscription_status!=='pending_activation') return this.activation.status(actor);
        const verified=row=>Boolean(row && row.reservation_status==='verified' && row.verified_at && !row.expired);
        const contact={telephoneVerified:verified(phone),emailVerified:verified(email),requiredChannels:['email']};
        return {accountId:account.id_login,businessId:account.id_business,subscriptionStatus:account.subscription_status,
            contact,commercialState:'unavailable',nextAction:contact.emailVerified?'unavailable':'verify_contacts',welcomePending:true};
    }
    channel(value) { if(!Object.hasOwn(kinds,value)) throw new RegistrationError('INVALID_REGISTRATION');return value; }
    async request(actor,body,ip) {
        exact(body,['channel']); const channel=this.channel(body.channel);
        if(channel!=='email') throw new RegistrationError('CONTACT_CHANNEL_UNAVAILABLE',503);
        if(!this.delivery.ready(channel)) throw new RegistrationError('CONTACT_PROVIDER_UNAVAILABLE',503);
        const initial=await this.account(actor);
        if(initial.subscription_status!=='pending_activation') throw new RegistrationError('CONTACT_ALREADY_VERIFIED',409);
        await this.limiter.consume([['send-ip',ip,20,3600],['send-account',initial.id_login,5,3600],['send-destination',channel+':'+initial[columns[channel]],5,3600]]);
        const code=String(randomInt(0,1000000)).padStart(6,'0'), id=randomUUID();
        const pending=await this.transaction(async tx=>{
            const account=await this.account(actor,tx), identity=await this.identity(account,channel,tx);
            if(account.subscription_status!=='pending_activation') throw new RegistrationError('CONTACT_ALREADY_VERIFIED',409);
            if(account[columns[channel]]!==initial[columns[channel]]) throw new RegistrationError('CONTACT_CHANGED',409);
            if(!identity) throw new RegistrationError('CONTACT_RESERVATION_LOST',409);
            if(identity.reservation_status==='verified') throw new RegistrationError('CONTACT_ALREADY_VERIFIED',409);
            const [last]=await this.query(`SELECT GREATEST(0,60-TIMESTAMPDIFF(SECOND,created_at,NOW(3))) retry
                FROM registration_contact_challenge WHERE id_login=:login AND channel=:channel ORDER BY created_at DESC LIMIT 1`,
            {login:account.id_login,channel},tx);
            if(last && last.retry>0) { const error=new RegistrationError('REGISTRATION_RATE_LIMITED',429);error.retryAfterSeconds=Number(last.retry);throw error; }
            // Reclaim only an expired reservation still owned by this authenticated account.
            if(identity.expired) await this.query(`UPDATE auth_identity SET expires_at=DATE_ADD(NOW(3),INTERVAL 24 HOUR),updated_at=NOW(3)
                WHERE kind=:kind AND normalized_value=:value AND id_login=:login AND reservation_status='pending'`,
            {kind:kinds[channel],value:account[columns[channel]],login:account.id_login},tx);
            const destinationHash=mac('contact-destination-v1',channel+':'+account[columns[channel]]);
            const codeHash=mac('contact-code-v1',[id,account.id_login,channel,destinationHash,code].join(':'));
            await this.query(`UPDATE registration_contact_challenge SET status='superseded'
                WHERE id_login=:login AND channel=:channel AND status IN ('sending','sent')`,{login:account.id_login,channel},tx);
            await this.query(`INSERT INTO registration_contact_challenge(challenge_id,id_login,id_business,channel,purpose,destination_hash,code_hash,status,expires_at)
                VALUES (:id,:login,:business,:channel,'registration_contact',:destinationHash,:codeHash,'sending',DATE_ADD(NOW(3),INTERVAL 10 MINUTE))`,
            {id,login:account.id_login,business:account.id_business,channel,destinationHash,codeHash},tx);
            const [saved]=await this.query('SELECT expires_at FROM registration_contact_challenge WHERE challenge_id=:id',{id},tx);
            return {to:account[columns[channel]],expiresAt:new Date(saved.expires_at).toISOString()};
        });
        // Never deliver while holding a database transaction. Only the HMAC is durable.
        const sent=await this.delivery.send({channel,to:pending.to,code,challengeId:id});
        await this.query(`UPDATE registration_contact_challenge SET status=:status WHERE challenge_id=:id AND status='sending'`,{id,status:sent?'sent':'failed'});
        if(!sent) throw new RegistrationError('CONTACT_PROVIDER_UNAVAILABLE',503);
        return {challengeId:id,channel,expiresAt:pending.expiresAt,resendAfterSeconds:60};
    }
    async confirm(actor,body,ip) {
        exact(body,['challengeId','code']);
        if(typeof body.challengeId!=='string'|| !/^[A-Za-z0-9_-]{1,50}$/.test(body.challengeId)
            ||typeof body.code!=='string'|| !/^[0-9]{6}$/.test(body.code)) throw new RegistrationError('CONTACT_CODE_INVALID',400);
        await this.limiter.consume([['confirm-ip',ip,100,3600],['confirm-account',actor.id_login,25,3600]]);
        const accepted=await this.transaction(async tx=>{
            const account=await this.account(actor,tx);
            const [challenge]=await this.query(`SELECT *,expires_at<=NOW(3) expired FROM registration_contact_challenge
                WHERE challenge_id=:id AND id_login=:login AND id_business=:business AND purpose='registration_contact' FOR UPDATE`,
            {id:body.challengeId,login:account.id_login,business:account.id_business},tx);
            if(!challenge || challenge.expired || !['sent','consumed'].includes(challenge.status)
                || (challenge.status==='sent' && challenge.guesses>=5)) return false;
            if(challenge.channel!=='email') return false;
            const identity=await this.identity(account,challenge.channel,tx);
            const destination=mac('contact-destination-v1',challenge.channel+':'+account[columns[challenge.channel]]);
            if(!identity || identity.expired || !equal(destination,challenge.destination_hash)) return false;
            const valid=equal(challenge.code_hash,mac('contact-code-v1',[challenge.challenge_id,account.id_login,challenge.channel,destination,body.code].join(':')));
            if(challenge.status==='consumed') return valid && identity.reservation_status==='verified';
            if(account.subscription_status!=='pending_activation') return false;
            await this.query(`UPDATE registration_contact_challenge SET guesses=guesses+1,
                status=:status,consumed_at=IF(:valid = 1,NOW(3),NULL) WHERE challenge_id=:id`,
            {id:challenge.challenge_id,valid:valid?1:0,status:valid?'consumed':challenge.guesses>=4?'locked':'sent'},tx);
            if(!valid) return false; // Commit wrong guesses, never roll back the counter.
            await this.query(`UPDATE auth_identity SET reservation_status='verified',verified_at=NOW(3),expires_at=NULL,updated_at=NOW(3)
                WHERE kind=:kind AND normalized_value=:value AND id_login=:login`,
            {kind:kinds[challenge.channel],value:account[columns[challenge.channel]],login:account.id_login},tx);
            if(!await this.activation.activateVerifiedEmail(account.id_login,tx)) throw new RegistrationError('ACTIVATION_REQUIRED',409);
            return true;
        });
        if(!accepted) throw new RegistrationError('CONTACT_CODE_INVALID',400);
        return this.status(actor);
    }
    async replace(actor,body,ip) {
        exact(body,['channel','value']);const channel=this.channel(body.channel);
        const value=channel==='sms' ? (typeof body.value==='string'&&/^[0-9]{10}$/.test(body.value)?body.value:null) : normalizeEmail(body.value);
        if(!value) throw new RegistrationError('INVALID_REGISTRATION');
        await this.limiter.consume([['replace-ip',ip,20,3600],['replace-account',actor.id_login,5,3600]]);
        await this.transaction(async tx=>{
            const account=await this.account(actor,tx),current=await this.identity(account,channel,tx);
            if(account.subscription_status!=='pending_activation') throw new RegistrationError('CONTACT_REAUTHENTICATION_REQUIRED',409);
            if(current?.reservation_status==='verified') throw new RegistrationError('CONTACT_REAUTHENTICATION_REQUIRED',409);
            if(channel==='email' && !current && account.email===value) throw new RegistrationError('CONTACT_RESERVATION_LOST',409);
            if(account[columns[channel]]===value) return;
            // S27 treats self-registration phones as contacts; email ownership stays unique.
            await this.query(`UPDATE login SET ${columns[channel]}=:value WHERE id_login=:login AND id_business=:business`,
            {value,login:account.id_login,business:account.id_business},tx);
            if(channel==='email') {
                await this.query(`UPDATE auth_identity SET reservation_status='pending',expires_at=NOW(3),updated_at=NOW(3)
                    WHERE kind='email' AND normalized_value=:old AND id_login=:login AND reservation_status IN ('pending','reserved')`,
                {old:account.email,login:account.id_login},tx);
                // Returning to an earlier owned value still requires a new code.
                await this.query(`UPDATE auth_identity SET reservation_status='pending',verified_at=NULL,expires_at=DATE_ADD(NOW(3),INTERVAL 24 HOUR),updated_at=NOW(3)
                    WHERE kind='email' AND normalized_value=:value AND id_login=:login AND reservation_status='pending'`,
                {value,login:account.id_login},tx);
            }
            await this.query(`UPDATE registration_contact_challenge SET status='superseded'
                WHERE id_login=:login AND channel=:channel AND status IN ('sending','sent')`,{login:account.id_login,channel},tx);
        });
        return this.status(actor);
    }
}
module.exports={ContactVerificationService};

'use strict';
const {randomUUID,createHmac,timingSafeEqual}=require('node:crypto');
const {QueryTypes}=require('sequelize');
const sequelize=require('../../db/Sequelize.connection');
const {BusinessProvisioning}=require('./businessProvisioning');
const {SaasLegalDao}=require('../../Dao/mysql/saasLegal.dao');
const {AdminAuditDao}=require('../../Dao/mysql/adminAudit.dao');
const passwords=require('../security/registrationPassword.service');
const {validateRegistration}=require('./registration.validator');
const {RegistrationError}=require('./errors');

function configuredKey() {
    const value=process.env.REGISTRATION_HMAC_KEY || '';
    return /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value,'hex') : null;
}
function same(a,b) {
    return typeof a==='string' && typeof b==='string' && a.length===b.length
        && timingSafeEqual(Buffer.from(a),Buffer.from(b));
}
const requireSuccess=result=>{if(!result.success) throw new RegistrationError(result.code,result.status);return result.data;};

class RegistrationService {
    constructor(database=sequelize, options={}) {
        this.db=database;
        this.provisioning=new BusinessProvisioning(database);
        this.legal=new SaasLegalDao(database);
        this.audit=new AdminAuditDao(database);
        this.key=options.key || configuredKey;
        this.identityEnabled=options.identityEnabled || (()=>process.env.REGISTRATION_IDENTITY_ENABLED==='true');
        this.loadBlocklist=options.loadBlocklist || passwords.configuredBlocklist;
    }
    query(sql,replacements,transaction,type=QueryTypes.SELECT) {return this.db.query(sql,{replacements,transaction,type});}
    async create(source, attempt) {
        let transaction;
        try {
            const input=validateRegistration(source);
            if (!attempt || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(attempt.id || '')
                || !/^[a-f0-9]{64}$/i.test(attempt.secret || '')) throw new RegistrationError('REGISTRATION_ATTEMPT_INVALID');
            const key=this.key();
            if (!this.identityEnabled() || !Buffer.isBuffer(key) || key.length!==32) throw new RegistrationError('REGISTRATION_UNAVAILABLE',503);
            const hmac=(purpose,value)=>createHmac('sha256',key).update(purpose+'\0'+value).digest('hex');
            const scope=hmac('registration-scope-v1',attempt.secret);
            const fingerprint=hmac('registration-payload-v1',JSON.stringify(input));
            const passwordHash=await passwords.hash(input.account.password,this.loadBlocklist);
            const idLogin=randomUUID(), idBusiness=randomUUID();
            transaction=await this.db.transaction();
            await this.query(`INSERT INTO registration_attempt (attempt_id,scope_hash,payload_hash,id_login,id_business,expires_at)
                VALUES (:attempt,:scope,:payload,:login,:business,DATE_ADD(NOW(3),INTERVAL 24 HOUR))
                ON DUPLICATE KEY UPDATE attempt_id=registration_attempt.attempt_id`,
            {attempt:attempt.id,scope,payload:fingerprint,login:idLogin,business:idBusiness},transaction,QueryTypes.INSERT);
            const existing=(await this.query(`SELECT *,expires_at<=NOW(3) AS expired FROM registration_attempt WHERE attempt_id=:attempt FOR UPDATE`,{attempt:attempt.id},transaction))[0];
            if (!existing || !same(existing.scope_hash,scope) || !same(existing.payload_hash,fingerprint)) throw new RegistrationError('REGISTRATION_ATTEMPT_CONFLICT',409);
            if (existing.expired) throw new RegistrationError('REGISTRATION_ATTEMPT_EXPIRED',409);
            if (existing.id_login!==idLogin) {
                await transaction.commit();
                // This is a receipt, not an authentication grant. R2-C must prove
                // current credentials/ownership before issuing any session.
                return {status:200,success:true,data:{idBusiness:existing.id_business,idLogin:existing.id_login,replayed:true}};
            }
            const legal=requireSuccess(await this.legal.registrationVersions(input.legalAcceptances,transaction));
            const roles=await this.query("SELECT id_rol,code FROM rol WHERE active=1 AND code='admin' LIMIT 1 FOR UPDATE",{},transaction);
            if (!roles[0]) throw new RegistrationError('REGISTRATION_UNAVAILABLE',503);
            const slug='consultorio-'+idBusiness; // Visible names may repeat; random unique slug is server-owned.
            await this.provisioning.business({_id_business:idBusiness,_name:input.business.name,_legal_name:null,_slug:slug,
                _email:null,_phone:null,_address:null,_status:'active',_subscription_status:'pending_activation',
                _trial_starts_at:null,_trial_ends_at:null,_trial_days:0,_plan:null,_active:1,_created_by:idLogin},transaction);
            await this.provisioning.defaults(idBusiness,idLogin,transaction);
            await this.provisioning.administrator({_id_login:idLogin,_id_business:idBusiness,_id_rol:roles[0].id_rol,
                _name:input.account.name,_email:input.account.email,_telephone:input.account.telephone,_password:passwordHash,_created_by:idLogin},transaction);
            if(require('./accountActivation.service').enabled()) await this.query(
                'INSERT INTO registration_account(id_login,id_business) VALUES (:login,:business)',
                {login:idLogin,business:idBusiness},transaction,QueryTypes.INSERT);
            const actor={id_login:idLogin,id_business:idBusiness,rol:'admin'};
            for(const version of legal.versions) requireSuccess(await this.legal.acceptInTransaction(actor,{id_version:version.versionId,acknowledged:true},transaction));
            await this.audit.record('SELF_REGISTRATION_CREATED',{actor_login_id:idLogin,actor_role:'self_registration',target_type:'business',
                target_id:idBusiness,target_login_id:idLogin,target_business_id:idBusiness,
                metadata:{source:'self_registration',attemptId:attempt.id,versions:legal.versions}}, {transaction,strict:true});
            await this.query(`INSERT INTO registration_outbox(event_id,attempt_id,event_type,id_login,id_business,created_at)
                VALUES (:event,:attempt,'registration.created',:login,:business,NOW(3))`,
            {event:randomUUID(),attempt:attempt.id,login:idLogin,business:idBusiness},transaction,QueryTypes.INSERT);
            await transaction.commit();
            return {status:201,success:true,data:{idBusiness,idLogin,replayed:false}};
        } catch(error) {
            if(transaction && !transaction.finished) {try{await transaction.rollback();}catch(_) { /* Do not expose driver details. */ }}
            if(error instanceof RegistrationError) return {status:error.status,success:false,code:error.code,data:null};
            const driver=error.original || error.parent || error;
            if(driver.sqlMessage==='REG_IDENTITY_CONFLICT') return {status:409,success:false,code:'REGISTRATION_IDENTITY_CONFLICT',data:null};
            // Commit outcome may be unknown after connection loss; retry the same
            // attempt. Never advertise that no account exists after a generic error.
            return {status:503,success:false,code:'REGISTRATION_UNAVAILABLE',data:null};
        }
    }
}
module.exports={RegistrationService};

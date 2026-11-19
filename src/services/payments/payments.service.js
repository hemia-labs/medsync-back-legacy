'use strict';
const {QueryTypes}=require('sequelize');
const {v5:uuidV5}=require('uuid');
const {RegistrationError,invalidSession}=require('../registration/errors');
const {LicenseProjection}=require('./licenseProjection');
const {paymentUpdates}=require('./paymentUpdates.service');
const {commercialState}=require('./paidLicense');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const unavailable=()=>new RegistrationError('BILLING_UNAVAILABLE',503);
const invalid=()=>new RegistrationError('INVALID_PAYMENT_REQUEST',400);
function object(value,required=[],optional=[]) {
    if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>32768
        ||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>![...required,...optional].includes(key)))throw invalid();
    return value;
}
function identifier(value) {if(typeof value!=='string'||!uuid.test(value))throw invalid();return value.toLowerCase();}
function offerCode(value) {if(typeof value!=='string'||!value||value.length>120||/\s/.test(value))throw invalid();return value;}
function membershipId(business,login) {
    // A native MedSync association, not an Access organization/membership.
    return uuidV5('medsync-membership:'+business+':'+login,uuidV5.URL);
}
class PaymentsService {
    constructor(db,options={}) {
        this.db=db;this.env=options.env||process.env;this.sdk=options.sdk;this.injectedRuntime=options.runtime;
        this.cachedRuntime=null;this.catalogCache=null;this.catalogExpires=0;this.catalogPending=null;
        this.projection=options.projection||new LicenseProjection(db);
        this.checkoutLegal=options.checkoutLegal||null;
    }
    runtime() {
        if(this.injectedRuntime)return this.injectedRuntime;
        if(this.cachedRuntime)return this.cachedRuntime;
        try {
            const sdk=this.sdk||require('@hemia/payments');
            const connection=JSON.parse(this.env.PAYMENTS_CONNECTION||'null');
            if(!connection||connection.productCode!=='medsync'||connection.clientId!==this.env.HEMIA_CLIENT_ID
                ||typeof this.env.HEMIA_CLIENT_SECRET!=='string'||!this.env.HEMIA_CLIENT_SECRET)throw unavailable();
            const config={...connection,clientSecret:this.env.HEMIA_CLIENT_SECRET,
                allowHttpLoopback:this.env.NODE_ENV!=='production'&&connection.allowHttpLoopback===true};
            const client=sdk.createPaymentsClient(config);
            const legal=config.legal?sdk.createPaymentsLegalClient(config,{resolveContext:input=>this.resolveLegalContext(input)}):null;
            const receiver=sdk.createPaymentsReceiver(config,{onSnapshot:async snapshot=>{
                const result=await this.projection.apply(snapshot);
                // Reconciliation may have committed an even newer revision before this webhook arrived.
                const committed=result.applied?snapshot:await this.currentSnapshot(snapshot.organizationId);
                if(committed)paymentUpdates.publish(snapshot.organizationId,committed);
                return result;
            }});
            this.cachedRuntime={config,client,legal,receiver};return this.cachedRuntime;
        }catch(_){throw unavailable();}
    }
    checkoutReady(runtime) {
        return Boolean(runtime.config.successUrl&&runtime.config.cancelUrl&&runtime.config.receiver?.audience
            &&runtime.config.legal?.verificationClientId);
    }
    async call(fn) {
        try{return await fn();}catch(error) {
            if(error instanceof RegistrationError)throw error;
            if(error?.code==='CHECKOUT_IN_PROGRESS') {
                const mapped=new RegistrationError('CHECKOUT_IN_PROGRESS',409);mapped.retryAfterSeconds=error.retryAfterSeconds||5;throw mapped;
            }
            if(error?.status===404)throw new RegistrationError('PAYMENT_NOT_FOUND',404);
            if(error?.status===409)throw new RegistrationError('PAYMENT_CONFLICT',409);
            if(error?.code==='configuration'&&error?.status===400)throw invalid();
            // Machine OAuth failures are service availability failures, never a browser logout.
            throw unavailable();
        }
    }
    async nativeContext(subject,business,session,{requireSession=true}={}) {
        identifier(subject);identifier(business);if(requireSession)identifier(session);
        const rows=await this.db.query(`SELECT l.id_login,l.id_business,b.subscription_status,r.code AS rol,
            EXISTS(SELECT 1 FROM auth_identity i WHERE i.id_login=l.id_login AND i.kind='email'
                AND i.normalized_value=l.email AND i.reservation_status='verified'
                AND i.verified_at IS NOT NULL AND i.expires_at IS NULL) AS email_verified
            FROM login l JOIN rol r ON r.id_rol=l.id_rol AND r.active=1
            JOIN business b ON b.id_business=l.id_business
            ${requireSession?'JOIN `session` s ON s.id_login=l.id_login AND s.id_session=:session AND s.active=1 AND s.`last`=1':''}
            WHERE l.id_login=:login AND l.id_business=:business AND l.active=1 AND l.locked=0
                AND b.active=1 AND b.status='active' LIMIT 1`,
        {replacements:{login:subject,business,...(requireSession?{session}:{})},type:QueryTypes.SELECT});
        if(!rows[0])throw new RegistrationError('PAYMENTS_FORBIDDEN',403);
        const row=rows[0];
        if(String(row.subscription_status||'').trim().toLowerCase()==='pending_activation')throw new RegistrationError('PAYMENTS_FORBIDDEN',403);
        return {...row,id_login:String(row.id_login).toLowerCase(),id_business:String(row.id_business).toLowerCase()};
    }
    async context(actor,{checkout=false}={}) {
        if(!actor?.id_login||!actor?.id_business||!actor?.id_session)throw invalidSession();
        const row=await this.nativeContext(actor.id_login,actor.id_business,actor.id_session);
        if(row.rol!=='admin')throw new RegistrationError('PAYMENTS_FORBIDDEN',403);
        if(checkout&&![1,true,'1'].includes(row.email_verified))throw new RegistrationError('CONTACT_VERIFICATION_REQUIRED',409);
        return {organizationId:row.id_business,subjectId:row.id_login,sessionId:actor.id_session.toLowerCase(),membershipId:membershipId(row.id_business,row.id_login)};
    }
    async resolveLegalContext(input) {
        object(input,['organizationId','subjectId','purpose'],['sessionId']);
        if(!['acceptance','checkout_validation'].includes(input.purpose))throw invalid();
        const row=await this.nativeContext(input.subjectId,input.organizationId,input.sessionId,{requireSession:input.purpose==='acceptance'});
        return {organizationId:row.id_business,subjectId:row.id_login,membershipId:membershipId(row.id_business,row.id_login),roles:[row.rol],canContract:row.rol==='admin'&&[1,true,'1'].includes(row.email_verified)};
    }
    async plans() {
        if(this.catalogCache&&Date.now()<this.catalogExpires)return this.catalogCache;
        if(this.catalogPending)return this.catalogPending;
        this.catalogPending=(async()=>{
            try {
                const runtime=this.runtime();
                await runtime.client.verifyCompatibility();
                const plans=await runtime.client.catalog.listPlans();
                if(!plans.length)throw unavailable();
                const offers=plans.map(plan=>({code:plan.code,name:plan.name,description:plan.description,prices:plan.prices,featureDetails:plan.features,
                    features:Object.fromEntries(plan.features.map(feature=>[feature.code,feature.value]))}));
                this.catalogCache={available:true,checkoutAvailable:this.checkoutReady(runtime),offers,planId:'professional',trialDays:15,taxBehavior:'inclusive'};
                this.catalogExpires=Date.now()+60000;
            }catch(_) {
                this.catalogCache={available:false,checkoutAvailable:false,offers:[],reason:'catalog_unavailable',planId:'professional',trialDays:15};
                this.catalogExpires=Date.now()+10000;
            }
            return this.catalogCache;
        })();
        try{return await this.catalogPending;}finally{this.catalogPending=null;}
    }
    buyer(context){return {organizationId:context.organizationId,userId:context.subjectId};}
    returnUrls(config,id,pathname='/cuenta/planes') {
        const success=new URL(config.successUrl),cancel=new URL(config.cancelUrl);
        for(const [url,result] of [[success,'approved'],[cancel,'cancelled']]) {
            url.pathname=pathname;url.search='';url.hash='';url.searchParams.set('attempt_id',id);url.searchParams.set('result',result);
        }
        return {successUrl:success.href,cancelUrl:cancel.href};
    }
    async createAttempt(actor,input) {
        object(input,['idempotencyKey','planCode','planPriceCode'],['legalAcceptanceId']);identifier(input.idempotencyKey);
        const context=await this.context(actor,{checkout:true});
        const runtime=this.runtime();if(!this.checkoutReady(runtime))throw unavailable();
        if(!uuid.test(input.legalAcceptanceId||''))throw new RegistrationError('PAYMENT_LEGAL_ACCEPTANCE_REQUIRED',409);
        return this.call(()=>runtime.client.attempts.create({...input,...this.buyer(context),operation:'checkout',...this.returnUrls(runtime.config,input.idempotencyKey)}));
    }
    async planChangeQuote(actor,input) {
        object(input,['expectedSubscriptionId','targetPlanCode','targetPlanPriceCode']);
        const expected=identifier(input.expectedSubscriptionId);offerCode(input.targetPlanCode);offerCode(input.targetPlanPriceCode);
        const context=await this.context(actor),runtime=this.runtime();
        return this.call(async()=>{
            const current=await runtime.client.subscriptions.current(context.organizationId);
            if(!current||current.id!==expected)throw new RegistrationError('PAYMENT_CONFLICT',409);
            if(current.organizationId!==context.organizationId||current.productCode!=='medsync')throw unavailable();
            return runtime.client.subscriptions.planChangeQuote(current.id,input.targetPlanCode,input.targetPlanPriceCode);
        });
    }
    async createPlanChangeAttempt(actor,input) {
        object(input,['idempotencyKey','expectedSubscriptionId','planCode','planPriceCode','expectedAmountDueNow','legalAcceptanceId']);
        const id=identifier(input.idempotencyKey),expected=identifier(input.expectedSubscriptionId);
        offerCode(input.planCode);offerCode(input.planPriceCode);
        if(typeof input.expectedAmountDueNow!=='string'||!/^\d{1,10}\.\d{2}$/.test(input.expectedAmountDueNow))throw invalid();
        if(typeof input.legalAcceptanceId!=='string'||!uuid.test(input.legalAcceptanceId))throw new RegistrationError('PAYMENT_LEGAL_ACCEPTANCE_REQUIRED',409);
        const context=await this.context(actor,{checkout:true}),runtime=this.runtime();
        if(!this.checkoutReady(runtime))throw unavailable();
        return this.call(async()=>{
            let original;
            try {
                original=await runtime.client.attempts.get(id,this.buyer(context));
                if(!original||original.attemptId!==id)throw unavailable();
            }
            catch(error) {if(error?.status!==404)throw error;}
            if(original) {
                if(original.operation!=='change_plan')throw new RegistrationError('PAYMENT_CONFLICT',409);
            } else {
                const current=await runtime.client.subscriptions.current(context.organizationId);
                if(!current||current.id!==expected||current.status!=='active'||current.cancelAtPeriodEnd||current.cancellation)throw new RegistrationError('PAYMENT_CONFLICT',409);
                if(current.organizationId!==context.organizationId||current.productCode!=='medsync')throw unavailable();
            }
            // Billing compares the frozen payload on replay, including the accepted quote and consent.
            return runtime.client.attempts.create({...input,idempotencyKey:id,expectedSubscriptionId:expected,legalAcceptanceId:input.legalAcceptanceId.toLowerCase(),
                ...this.buyer(context),operation:'change_plan',...this.returnUrls(runtime.config,id,'/cuenta/cambiar-plan')});
        });
    }
    async confirmAttempt(actor,id,input) {
        object(input);id=identifier(id);
        const context=await this.context(actor,{checkout:true}),runtime=this.runtime(),buyer=this.buyer(context);
        return this.call(async()=>{
            const original=await runtime.client.attempts.get(id,buyer);
            if(original.attemptId!==id||original.operation!=='change_plan'||original.status!=='ready'||original.abandoned)throw new RegistrationError('PAYMENT_CONFLICT',409);
            if(!uuid.test(original.checkoutId||'')||!uuid.test(original.subscriptionId||''))throw unavailable();
            const confirmed=await runtime.client.attempts.confirm(id,buyer);
            if(confirmed.attemptId!==id||confirmed.operation!=='change_plan'||confirmed.checkoutId!==original.checkoutId||confirmed.subscriptionId!==original.subscriptionId)throw unavailable();
            await this.synchronize(context.organizationId);
            const current=await runtime.client.attempts.get(id,buyer);
            if(current.attemptId!==id||current.operation!=='change_plan'||current.checkoutId!==original.checkoutId||current.subscriptionId!==original.subscriptionId)throw unavailable();
            return current;
        });
    }
    async getAttempt(actor,id) {
        identifier(id);const context=await this.context(actor);
        return this.call(()=>this.runtime().client.attempts.get(id,this.buyer(context)));
    }
    async cancelPlanChangeAttempt(actor,id,input) {
        object(input);id=identifier(id);
        const context=await this.context(actor,{checkout:true}),runtime=this.runtime(),buyer=this.buyer(context);
        return this.call(async()=>{
            const conflict=()=>new RegistrationError('PAYMENT_CONFLICT',409);
            const authorized=change=>{
                if(['scheduled','effective'].includes(change?.state)||change?.action==='approve_payment')
                    throw new RegistrationError('PLAN_CHANGE_ALREADY_AUTHORIZED',409);
            };
            const original=await runtime.client.attempts.get(id,buyer);
            if(!original||original.attemptId!==id)throw unavailable();
            if(original.operation!=='change_plan'||original.abandoned)throw conflict();
            if(!uuid.test(original.checkoutId||'')||!uuid.test(original.subscriptionId||'')
                ||typeof original.planCode!=='string'||!original.planCode||typeof original.planPriceCode!=='string'||!original.planPriceCode)throw unavailable();
            const cancelled=receipt=>receipt?.status==='rejected'&&receipt.statusFresh===true&&receipt.checkoutStatus==='cancelled'
                &&receipt.errorCode==='PAYMENT_ATTEMPT_CANCELLED';
            const source=async()=>{
                const current=await runtime.client.subscriptions.current(context.organizationId);
                if(!current||current.id!==original.subscriptionId)throw conflict();
                if(current.organizationId!==context.organizationId||current.productCode!=='medsync')throw unavailable();
                return current;
            };
            if(!cancelled(original)) {
                authorized(original.planChange);
                if(original.status!=='ready'||original.statusFresh!==true||original.errorCode
                    ||!['preparing','awaiting_approval'].includes(original.planChange?.state)
                    ||original.planChange.action!=='approve_subscription')throw conflict();
                const current=await source(),pending=current.pendingPlanChange;
                authorized(pending);
                if(current.status!=='active'||current.cancelAtPeriodEnd||current.cancellation||!pending
                    ||!['preparing','awaiting_approval'].includes(pending.state)
                    ||pending.checkoutId!==original.checkoutId||pending.newSubscriptionId!==original.subscriptionId
                    ||(pending.attemptId!==undefined&&pending.attemptId!==id)
                    ||pending.targetPlanCode!==original.planCode||pending.targetPlanPriceCode!==original.planPriceCode)throw conflict();
                const result=await runtime.client.attempts.cancel(id,buyer);
                if(!result||typeof result!=='object'||Array.isArray(result)||typeof result.cancelled!=='boolean'
                    ||(result.abandoned!==undefined&&result.abandoned!==false)
                    ||(result.cancelled&&result.approvalUrl!==undefined))throw unavailable();
                if(result.approvalUrl!==undefined) {
                    let url;
                    try {url=new URL(result.approvalUrl);}catch(_){throw unavailable();}
                    if(typeof result.approvalUrl!=='string'||/[\\\s]/.test(result.approvalUrl)||url.protocol!=='https:'
                        ||!['www.paypal.com','www.sandbox.paypal.com'].includes(url.hostname)
                        ||url.username||url.password||url.port)throw unavailable();
                }
                if(!result.cancelled)return {cancelled:false,...(result.approvalUrl===undefined?{}:{approvalUrl:result.approvalUrl})};
            }
            // A successful POST alone does not prove that preparation was discarded.
            const receipt=await runtime.client.attempts.get(id,buyer);
            if(!receipt||receipt.attemptId!==id||receipt.operation!=='change_plan'||receipt.checkoutId!==original.checkoutId
                ||receipt.subscriptionId!==original.subscriptionId||receipt.planCode!==original.planCode||receipt.planPriceCode!==original.planPriceCode
                ||!cancelled(receipt)||receipt.abandoned
                ||(receipt.planChange&&(receipt.planChange.state!=='failed'||receipt.planChange.action!=='none')))throw unavailable();
            const current=await source();
            if(current.pendingPlanChange&&current.pendingPlanChange.state!=='failed')throw conflict();
            return {cancelled:true};
        });
    }
    async retry(actor,id,input) {
        object(input);identifier(id);const context=await this.context(actor,{checkout:true});
        return this.call(()=>this.runtime().client.attempts.retry(id,this.buyer(context)));
    }
    async verify(actor,id,input) {
        object(input);identifier(id);const context=await this.context(actor,{checkout:true});
        const runtime=this.runtime();
        return this.call(async()=>{
            const receipt=await runtime.client.attempts.get(id,this.buyer(context));
            if(receipt.operation&&receipt.operation!=='checkout')throw new RegistrationError('PAYMENT_CONFLICT',409);
            if(!receipt.checkoutId)return receipt;
            const checked=await runtime.client.checkout.verify(receipt.checkoutId);
            if(checked.checkoutId!==receipt.checkoutId||checked.subscriptionId!==receipt.subscriptionId)throw unavailable();
            await this.synchronize(context.organizationId);
            return runtime.client.attempts.get(id,this.buyer(context));
        });
    }
    async history(actor,input={}) {
        object(input,[],['cursor']);
        if(input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor||input.cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(input.cursor)))throw invalid();
        const context=await this.context(actor);
        return this.call(async()=>{
            const page=await this.runtime().client.payments.list(context.organizationId,input.cursor?{cursor:input.cursor}:{});
            if(!page||!Array.isArray(page.items)||page.items.length>25
                ||!(page.nextCursor===null||typeof page.nextCursor==='string'&&page.nextCursor.length>0&&page.nextCursor.length<=2048&&/^[A-Za-z0-9_-]+$/.test(page.nextCursor))
                ||page.items.some(payment=>!payment||payment.organizationId!==context.organizationId||payment.productCode!=='medsync'
                    ||payment.provider!=='paypal'||!['paid','partially_refunded','refunded','reversed'].includes(payment.status)))throw unavailable();
            return page;
        });
    }
    async subscription(actor) {const context=await this.context(actor);return this.call(()=>this.runtime().client.subscriptions.current(context.organizationId));}
    async savedSubscriptionSnapshot(actor) {
        const context=await this.context(actor);
        return this.currentSnapshot(context.organizationId);
    }
    async currentSnapshot(organizationId) {
        const [business]=await this.db.query('SELECT billing_snapshot FROM business WHERE id_business=:business LIMIT 1',
            {replacements:{business:organizationId},type:QueryTypes.SELECT});
        if(!business?.billing_snapshot)return null;
        const value=typeof business.billing_snapshot==='string'?JSON.parse(business.billing_snapshot):business.billing_snapshot;
        return require('@hemia/payments').parsePaymentSnapshot(value,'medsync',organizationId);
    }
    async license(actor) {const context=await this.context(actor);return (await this.synchronize(context.organizationId)).license;}
    async cancelSubscription(actor,input) {
        object(input,['idempotencyKey','expectedSubscriptionId','expectedPeriodEnd']);
        const key=identifier(input.idempotencyKey),expectedId=identifier(input.expectedSubscriptionId);
        if(typeof input.expectedPeriodEnd!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(input.expectedPeriodEnd)||!Number.isFinite(Date.parse(input.expectedPeriodEnd)))throw invalid();
        const context=await this.context(actor);
        return this.call(async()=>{
            const before=await this.synchronize(context.organizationId),sub=before.subscription;
            if(!sub||sub.id!==expectedId)throw new RegistrationError('PAYMENT_CONFLICT',409);
            if(before.organizationId!==context.organizationId||before.productCode!=='medsync'
                ||sub.organizationId!==context.organizationId||sub.productCode!=='medsync')throw unavailable();
            // Reconcile an existing intent instead of creating another provider cancellation.
            if(sub.cancelAtPeriodEnd||sub.cancellation)return {subscription:sub,license:before.license};
            const end=sub.currentPeriodEnd||sub.nextBillingTime;
            if(Date.parse(end)!==Date.parse(input.expectedPeriodEnd))throw new RegistrationError('PAYMENT_CONFLICT',409);
            if(!end||Date.parse(end)<=Date.now()||commercialState(before).status!=='active')throw new RegistrationError('PAYMENT_CANCELLATION_UNAVAILABLE',409);
            await this.runtime().client.subscriptions.cancel(sub.id,{idempotencyKey:key,actorUserId:context.subjectId});
            const after=await this.synchronize(context.organizationId);
            if(after.subscription?.id!==sub.id||!after.subscription.cancelAtPeriodEnd)throw unavailable();
            return {subscription:after.subscription,license:after.license};
        });
    }
    async synchronize(business) {
        identifier(business);
        return this.call(async()=>{
            const snapshot=await this.runtime().client.snapshots.current(business);
            const result=await this.projection.apply(snapshot);
            const committed=result.applied?snapshot:await this.currentSnapshot(business);
            if(committed)paymentUpdates.publish(business,committed);
            return snapshot;
        });
    }
    async receive(headers,input){return this.runtime().receiver.receive(headers,input);}
    async probe(headers,product){return this.runtime().receiver.probe(headers,product);}
    async prepareLegal(actor,input) {
        object(input,['idempotencyKey']);identifier(input.idempotencyKey);const context=await this.context(actor,{checkout:true});
        const runtime=this.runtime();if(!this.checkoutReady(runtime))throw unavailable();
        return this.call(async()=>{
            const prepared=await runtime.legal.prepare(context,input.idempotencyKey);
            if(!this.checkoutLegal)this.checkoutLegal=new(require('./checkoutLegal.service').CheckoutLegalService)(this.db,{env:this.env});
            return this.checkoutLegal.documents({...actor,id_login:context.subjectId,id_business:context.organizationId},prepared);
        });
    }
    async acceptLegal(actor,input) {
        object(input,['requestId','idempotencyKey','confirmations']);const context=await this.context(actor,{checkout:true});
        return this.call(()=>this.runtime().legal.accept(context,input));
    }
    async legalContext(headers,input) {
        const runtime=this.runtime();
        // Verified by the SDK with both signature and live OAuth introspection.
        await runtime.receiver.verifyLegal(headers);
        return runtime.legal.resolveContext(input);
    }
}
let singleton;
function configuredPayments(){if(!singleton)singleton=new PaymentsService(require('../../db/Sequelize.connection'));return singleton;}
module.exports={PaymentsService,configuredPayments,membershipId,object,identifier};

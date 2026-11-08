'use strict';
const express=require('express');
const jwt=require('jsonwebtoken');
const db=require('../../db/Sequelize.connection');
const Token=require('../../auth/authenticate');
const AuthDao=require('../../Dao/mysql/auth.dao');
const AuthController=require('../../controller/mysql/auth.controller');
const AuthCookies=require('../../config/authCookie.config');
const Security=require('../../config/security');
const Csrf=require('../../services/security/csrfToken.service');
const {csrfProtection}=require('../../middleware/csrf.middleware');
const {RegistrationService}=require('../../services/registration/registration.service');
const {ContactVerificationService}=require('../../services/registration/contactVerification.service');
const {AccountActivationService,enabled:activationEnabled}=require('../../services/registration/accountActivation.service');
const {RegistrationRateLimit}=require('../../services/registration/registrationRateLimit');
const {LegalRegistrationService}=require('../../services/registration/legalRegistration.service');
const {configuredDelivery}=require('../../services/registration/contactDelivery');
const Passwords=require('../../services/security/registrationPassword.service');
const {validateRegistration}=require('../../services/registration/registration.validator');
const {RegistrationError}=require('../../services/registration/errors');
const attemptSecurity=require('../../services/registration/registrationSecurity');

const messages={
    INVALID_REGISTRATION:'Revisa los datos de registro.',
    REGISTRATION_NOT_COMPLETED:'No fue posible completar el registro. Intenta iniciar sesion o recuperar tu acceso.',
    LEGAL_VERSION_CHANGED:'Los documentos cambiaron. Consulta y acepta las versiones vigentes.',
    ACCOUNT_ALREADY_AUTHENTICATED:'Ya tienes una sesion abierta.',
    CONTACT_CODE_INVALID:'El codigo no es valido o ya vencio. Revisa el codigo o solicita uno nuevo.',
    CONTACT_CHANNEL_UNAVAILABLE:'La verificacion por telefono no esta disponible. Verifica tu correo.',
    CONTACT_REAUTHENTICATION_REQUIRED:'Para cambiar un contacto verificado se requiere verificar nuevamente tu identidad.',
    REGISTRATION_RATE_LIMITED:'Espera antes de intentarlo de nuevo.',
    CSRF_FORBIDDEN:'Actualiza la pagina para continuar de forma segura.'
};
const publicCodes={REGISTRATION_VALIDATION_FAILED:'INVALID_REGISTRATION',PASSWORD_INVALID:'INVALID_REGISTRATION',
    REGISTRATION_IDENTITY_CONFLICT:'REGISTRATION_NOT_COMPLETED',LEGAL_VERSION_STALE:'LEGAL_VERSION_CHANGED',
    REGISTRATION_ATTEMPT_CONFLICT:'IDEMPOTENCY_CONFLICT',REGISTRATION_ATTEMPT_EXPIRED:'IDEMPOTENCY_EXPIRED'};
function sendError(res,error) {
    const identityConflict=(error.original||error.parent)?.sqlMessage==='REG_IDENTITY_CONFLICT';
    const known=error instanceof RegistrationError;
    const status=identityConflict?409:known?error.status:503;
    const code=identityConflict?'REGISTRATION_NOT_COMPLETED':known?(publicCodes[error.code]||error.code):'REGISTRATION_UNAVAILABLE';
    const body={code,message:messages[code]||'No se pudo completar esta accion. Conserva tus datos e intenta de nuevo.'};
    if(status===429) {body.retryAfterSeconds=Math.max(1,error.retryAfterSeconds||60);res.set('Retry-After',String(body.retryAfterSeconds));}
    return res.status(status).json(body);
}
function requireConfiguration() {
    const config=AuthCookies.assertAuthCookieConfig();
    if(!config.isCookieAuthEnabled || !Security.isCsrfEnabled() || process.env.REGISTRATION_IDENTITY_ENABLED!=='true')
        throw new RegistrationError('REGISTRATION_UNAVAILABLE',503);
    attemptSecurity.key();
}
function createRouter(options={}) {
    const database=options.database||db,delivery=options.delivery||configuredDelivery();
    const registration=options.registration||new RegistrationService(database);
    const contacts=new ContactVerificationService(database,delivery,options.preparation),limiter=new RegistrationRateLimit(database),legal=options.legal||new LegalRegistrationService(database);
    const activation=new AccountActivationService(database,options.preparation);
    const authenticate=options.authenticate||Token.Auth, optional=options.optionalAuth||Token.OptionalAuth;
    const login=options.login||((body,metadata)=>AuthDao.login(body,metadata));
    const router=express.Router();
    const run=fn=>async(req,res)=>{try{res.set('Cache-Control','no-store');await fn(req,res);}catch(error){sendError(res,error);}};
    const clean=(req,res,next)=>{
        // Existing auth/CSRF middleware uses a legacy envelope. Normalize it only
        // on these new endpoints so their documented error contract stays stable.
        const send=res.send;
        res.send=function(body) {
            if(this.statusCode>=400 && body && typeof body==='object' && !Buffer.isBuffer(body)) {
                const code=body.code||body.data?.code||(this.statusCode===401?'AUTH_REQUIRED':'REGISTRATION_UNAVAILABLE');
                const normalized={code,message:body.message||'No se pudo completar esta accion.'};
                if(Number.isInteger(body.retryAfterSeconds))normalized.retryAfterSeconds=body.retryAfterSeconds;
                return send.call(this,normalized);
            }
            return send.call(this,body);
        };
        if(Object.keys(req.query||{}).length) return sendError(res,new RegistrationError('INVALID_REGISTRATION'));
        res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});next();
    };
    const configuration=(req,res,next)=>{try{requireConfiguration();next();}catch(error){sendError(res,error);}};
    const origin=(req,res,next)=>{
        // Always enforce an explicit browser origin, including local registration.
        if(!Security.getCsrfAllowedOrigins().includes(req.get('origin'))) return sendError(res,new RegistrationError('CSRF_FORBIDDEN',403));
        next();
    };
    const csrfContext=type=>(req,res,next)=>{
        if(!req.csrf?.checked || req.csrf.contextType!==type) return sendError(res,new RegistrationError('CSRF_FORBIDDEN',403));
        next();
    };
    const anonymous=(req,res,next)=>{
        if(req.tokenDecode||req.authTokenPresent||req.authTokenInvalid) return sendError(res,new RegistrationError('ACCOUNT_ALREADY_AUTHENTICATED',409));
        next();
    };
    async function ready(checkPasswords=true) {
        requireConfiguration();
        if(process.env.REGISTRATION_ENABLED!=='true'||!delivery.ready('email')) throw new RegistrationError('REGISTRATION_UNAVAILABLE',503);
        if(checkPasswords) await Passwords.configuredBlocklist();
    }
    // Public product information must not depend on registration or email delivery readiness.
    router.get('/registration/plans',clean,run(async(req,res)=>{
        res.json(await require('../../services/registration/commercialAdapter').plans());
    }));
    router.get('/registration/context',clean,optional,run(async(req,res)=>{
        let enabled=true;
        try { await ready(false); } catch(_) {enabled=false;}
        if(!enabled) return res.json({enabled:false,planId:'professional',verificationChannels:['email'],legalDocuments:[],registrationAttemptExpiresAt:new Date().toISOString()});
        await limiter.consume([['context-ip',req.ip,60,900]]);
        await Passwords.configuredBlocklist();
        await legal.ready();
        const attempt=attemptSecurity.issueAttempt(req,res);
        const legalContext=await legal.context(attempt.secret);
        const csrf=Csrf.issueToken(req);res.cookie(Csrf.csrfCookieName(),csrf.token,Csrf.csrfCookieOptions());
        res.json({enabled:true,planId:'professional',verificationChannels:['email'],...legalContext,registrationAttemptExpiresAt:attempt.expiresAt});
    }));
    router.post('/auth/register',clean,configuration,optional,anonymous,origin,csrfProtection(),csrfContext('preauth'),run(async(req,res)=>{
        if(req.tokenDecode || req.authTokenPresent || req.authTokenInvalid) throw new RegistrationError('ACCOUNT_ALREADY_AUTHENTICATED',409);
        await ready();
        await limiter.consume([['register-ip',req.ip,20,900]]);
        const attempt=attemptSecurity.readAttempt(req);
        if(!attempt) throw new RegistrationError('REGISTRATION_ATTEMPT_INVALID',400);
        const input=validateRegistration(req.body),id=req.get('Idempotency-Key');
        if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id||'')) throw new RegistrationError('REGISTRATION_ATTEMPT_INVALID');
        await limiter.consume([['register-email',input.account.email,5,900]]);
        const result=await registration.create(input,{id,secret:attempt.secret});
        if(!result.success) throw new RegistrationError(result.code,result.status);
        const actor={id_login:result.data.idLogin,id_business:result.data.idBusiness};
        // A receipt never grants a session. The common login path proves the
        // CURRENT password/owner, including on replay after a reset or reclaim.
        let sessionEstablished=false;
        try {
            const auth=await login({param:input.account.email,pwd:input.account.password,refresh:true},
                {expectedLoginId:actor.id_login,ip:req.ip,userAgent:req.get('user-agent')});
            const decoded=auth?.data?.token?jwt.decode(auth.data.token):null;
            if(auth?.status===200 && decoded?.id_login===actor.id_login && decoded?.id_business===actor.id_business && decoded?.id_session) {
                // Issue all material before writing headers. No tokens in the DTO.
                const csrf=Csrf.issueToken({tokenDecode:decoded});
                AuthController.applyD2LoginCookies(auth,res);
                res.cookie(Csrf.csrfCookieName(),csrf.token,Csrf.csrfCookieOptions());sessionEstablished=true;
            }
        } catch(_) { // The committed account remains recoverable by normal login.
            res.removeHeader('Set-Cookie');
        }
        const activation=await contacts.status(actor);
        res.status(result.status).json({accountCreated:true,sessionEstablished,activation});
    }));
    router.get('/account/activation',clean,configuration,authenticate,run(async(req,res)=>res.json(await (activationEnabled()?activation:contacts).status(req.tokenDecode))));
    router.get('/account/activation/plans',clean,configuration,authenticate,run(async(req,res)=>{
        if(activationEnabled()) return res.json(await activation.plans(req.tokenDecode));
        await contacts.account(req.tokenDecode);res.json({available:false,offers:[],reason:'provider_unavailable'});
    }));
    router.post('/account/activation/checkout',clean,configuration,authenticate,origin,csrfProtection(),csrfContext('session'),
        run(async(req,res)=>res.json(await activation.checkout(req.tokenDecode))));
    router.post('/account/setup-welcome/acknowledge',clean,configuration,authenticate,origin,csrfProtection(),csrfContext('session'),
        run(async(req,res)=>res.json(await activation.acknowledge(req.tokenDecode,req.body))));
    const mutations=[['post','/account/contact-verifications','request',202],['post','/account/contact-verifications/confirm','confirm',200],['patch','/account/activation/contact','replace',200]];
    for(const [method,path,action,status] of mutations) router[method](path,clean,configuration,authenticate,origin,csrfProtection(),csrfContext('session'),
        run(async(req,res)=>res.status(status).json(await contacts[action](req.tokenDecode,req.body,req.ip))));
    router.use((error,req,res,next)=>sendError(res,error));
    return router;
}
module.exports=createRouter();
module.exports.createRouter=createRouter;

'use strict';
const express=require('express');
const Token=require('../../auth/authenticate');
const Security=require('../../config/security');
const {csrfProtection}=require('../../middleware/csrf.middleware');
const {RegistrationError}=require('../../services/registration/errors');
const {configuredPayments}=require('../../services/payments/payments.service');
const {paymentUpdates}=require('../../services/payments/paymentUpdates.service');
const messages={BILLING_UNAVAILABLE:'Los pagos no están disponibles. Conserva tu intento y vuelve a consultar.',PAYMENTS_FORBIDDEN:'No tienes permiso para administrar los pagos de este consultorio.',PAYMENT_LEGAL_ACCEPTANCE_REQUIRED:'Revisa y acepta los documentos de contratación.',INVALID_PAYMENT_REQUEST:'Revisa los datos del intento de pago.',PAYMENT_NOT_FOUND:'No se encontró este intento de pago.',PAYMENT_CONFLICT:'El intento cambió. Consulta su estado antes de continuar.',CONTACT_VERIFICATION_REQUIRED:'Verifica tu correo antes de contratar.'};
function errorResponse(res,error) {
    const known=error instanceof RegistrationError;
    const status=known?error.status:503,code=known?error.code:'BILLING_UNAVAILABLE';
    if(error.retryAfterSeconds)res.set('Retry-After',String(error.retryAfterSeconds));
    const body={status,code,message:code==='PLAN_CHANGE_ALREADY_AUTHORIZED'?'Este cambio ya fue autorizado. Consulta su estado antes de continuar.':code==='PAYMENT_CANCELLATION_UNAVAILABLE'?'No hay un periodo pagado vigente confirmado para cancelar la renovación.':messages[code]||'No se pudo completar esta acción.',...(error.retryAfterSeconds?{retryAfterSeconds:error.retryAfterSeconds}:{})};
    return res.status(body.status).json(body);
}
const machineUnauthorized={status:401,code:'AUTH_ACCESS_INVALID'};
function machineErrorResponse(res,error,code,message) {
    if(error?.status===machineUnauthorized.status) {
        const body={...machineUnauthorized,message};
        return res.status(body.status).json(body);
    }
    const body={status:[400,403,409].includes(error?.status)?error.status:503,code,message};
    return res.status(body.status).json(body);
}
function createRouter(options={}) {
    const router=express.Router(),service=options.service||configuredPayments();
    const authenticate=options.authenticate||Token.Auth,csrf=options.csrf||csrfProtection();
    const run=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(error){errorResponse(res,error);}};
    router.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});next();});
    const machineHeaders=req=>({authorization:req.get('authorization'),timestamp:req.get('x-billing-timestamp')});
    const delivery=handler=>async(req,res)=>{try{res.json(await handler(req));}catch(error){
        machineErrorResponse(res,error,'BILLING_SYNC_UNAVAILABLE','No se pudo sincronizar la licencia.');
    }};
    router.get('/webhooks/license',delivery(req=>service.probe(machineHeaders(req),req.query.productCode)));
    router.post('/webhooks/license',delivery(req=>service.receive(machineHeaders(req),req.body)));
    // Machine authentication is separate from browser cookies/CSRF and runs first.
    router.post('/legal/context',async(req,res)=>{
        try {res.json(await service.legalContext({authorization:req.get('authorization')},req.body));}
        catch(error){machineErrorResponse(res,error,'LEGAL_CONTEXT_UNAVAILABLE','No se pudo validar el contexto de contratación.');}
    });
    router.use(authenticate);
    const mutation=(req,res,next)=>{
        if(!Security.getCsrfAllowedOrigins().includes(req.get('origin')))return errorResponse(res,new RegistrationError('CSRF_FORBIDDEN',403));
        csrf(req,res,()=>{
            if(!req.csrf?.checked||req.csrf.contextType!=='session')return errorResponse(res,new RegistrationError('CSRF_FORBIDDEN',403));
            next();
        });
    };
    router.get('/plans',run(async req=>{await service.context(req.tokenDecode);return service.plans();}));
    router.get('/history',run(req=>service.history(req.tokenDecode,req.query)));
    router.post('/checkout-attempts',mutation,run(req=>service.createAttempt(req.tokenDecode,req.body)));
    router.get('/checkout-attempts/:id',run(req=>service.getAttempt(req.tokenDecode,req.params.id)));
    router.get('/checkout-attempts/:id/events',async(req,res)=>{
        try {
            let origin=req.get('origin');
            if(!origin){try{origin=new URL(req.get('referer')).origin;}catch(_){}}
            if(!Security.getCsrfAllowedOrigins().includes(origin))throw new RegistrationError('PAYMENTS_FORBIDDEN',403);
            await service.getAttempt(req.tokenDecode,req.params.id);
            if(res.destroyed)return;
            (options.updates||paymentUpdates).open(req,res,{business:req.tokenDecode.id_business,
                expiresAt:Number(req.tokenDecode.exp)*1000,authorize:()=>service.context(req.tokenDecode)});
        }catch(error){if(res.headersSent)res.end();else errorResponse(res,error);}
    });
    router.post('/checkout-attempts/:id/retry',mutation,run(req=>service.retry(req.tokenDecode,req.params.id,req.body)));
    router.post('/checkout-attempts/:id/confirm',mutation,run(req=>service.confirmAttempt(req.tokenDecode,req.params.id,req.body)));
    router.post('/checkout-attempts/:id/cancel',mutation,run(req=>service.cancelPlanChangeAttempt(req.tokenDecode,req.params.id,req.body)));
    router.post('/checkout-attempts/:id/verify',mutation,run(req=>service.verify(req.tokenDecode,req.params.id,req.body)));
    router.get('/subscription',run(req=>service.subscription(req.tokenDecode)));
    router.get('/subscription/plan-change-quote',run(req=>service.planChangeQuote(req.tokenDecode,req.query)));
    router.post('/subscription/change-plan',mutation,run(req=>service.createPlanChangeAttempt(req.tokenDecode,req.body)));
    router.get('/subscription/snapshot',run(req=>service.savedSubscriptionSnapshot(req.tokenDecode)));
    router.get('/subscription/events',async(req,res)=>{
        try {
            let origin=req.get('origin');
            if(!origin){try{origin=new URL(req.get('referer')).origin;}catch(_){}}
            if(!Security.getCsrfAllowedOrigins().includes(origin))throw new RegistrationError('PAYMENTS_FORBIDDEN',403);
            await service.context(req.tokenDecode);
            if(res.destroyed)return;
            (options.updates||paymentUpdates).open(req,res,{business:req.tokenDecode.id_business,
                expiresAt:Number(req.tokenDecode.exp)*1000,authorize:()=>service.context(req.tokenDecode),
                snapshot:()=>service.savedSubscriptionSnapshot(req.tokenDecode)});
        }catch(error){if(res.headersSent)res.end();else errorResponse(res,error);}
    });
    router.post('/subscription/cancel',mutation,run(req=>service.cancelSubscription(req.tokenDecode,req.body)));
    router.get('/license',run(req=>service.license(req.tokenDecode)));
    router.post('/legal/prepare',mutation,run(req=>service.prepareLegal(req.tokenDecode,req.body)));
    router.post('/legal/accept',mutation,run(req=>service.acceptLegal(req.tokenDecode,req.body)));
    return router;
}
module.exports=createRouter();module.exports.createRouter=createRouter;

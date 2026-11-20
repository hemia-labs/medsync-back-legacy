const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const TracingController = require('../../controller/mysql/tracing.controller');
const { requirePermission } = require('../../middleware/requirePermission.middleware');

const drafts = require('../../Dao/mysql/evolutionDraft.dao');
const { applyTenantToBody } = require('../../util/tenant');
const csrfProtected = csrfProtection();

const draftPath = '/patient/:id_person/evolution-drafts';
router.get(draftPath, Token.Auth, requireTenantOperational, requirePermission('tracing.create'), awaitHandlerFactory(async (req,res) => {
    const result = await drafts.list(applyTenantToBody(req,{ id_person:req.params.id_person, page:req.query.page, origin:typeof req.query.origin === 'string' ? req.query.origin : undefined }));
    res.set('Cache-Control','no-store').status(result.status).send(result);
}));
router.get(draftPath+'/:id/review', Token.Auth, requireTenantOperational, requirePermission('tracing.create'), awaitHandlerFactory(async (req,res) => {
    const result=await drafts.review(applyTenantToBody(req,{id_person:req.params.id_person,id:req.params.id,revision:Number(req.query.revision)}));
    res.set('Cache-Control','no-store').status(result.status).send(result);
}));
router.put(draftPath+'/:id', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('tracing.create'), awaitHandlerFactory(async (req,res) => {
    const result = await drafts.save(applyTenantToBody(req,{ id_person:req.params.id_person, id:req.params.id,
        revision:req.body.revision, form:req.body.form }));
    res.set('Cache-Control','no-store').status(result.status).send(result);
}));

const signatures = require('../../Dao/mysql/evolutionSignature.dao');
const signedPath = '/patient/:id_person/evolution-notes';
router.get([signedPath,signedPath+'/:id/versions'], Token.Auth, requireTenantOperational,
    requirePermission('px.tab.monitoring'), awaitHandlerFactory(async (req,res) => {
        const result=await signatures.read(applyTenantToBody(req,{id_person:req.params.id_person,id:req.params.id,page:req.query.page}));
        res.set('Cache-Control','no-store').status(result.status).send(result);
    }));
for (const [action,permission] of [['sign','tracing.create'],['rectify','tracing.correct']]) {
    router.put(signedPath+'/:id/'+action, Token.Auth, csrfProtected, requireTenantOperational,
        requirePermission(permission), awaitHandlerFactory(async (req,res) => {
            const {revision,requestId,form,reason}=req.body;
            const result=await signatures.attest(applyTenantToBody(req,{id_person:req.params.id_person,id:req.params.id,revision,requestId,form,reason}),action==='rectify');
            res.set('Cache-Control','no-store').status(result.status).send(result);
        }));
}

router.get('/list/:id_person', Token.Auth, requireTenantOperational, requirePermission('px.tab.monitoring'), awaitHandlerFactory(TracingController.getTracing));
router.get('/patient/:id_person/:id_tracing/revisions', Token.Auth, requireTenantOperational, requirePermission('px.tab.monitoring'), awaitHandlerFactory(TracingController.revisions));

router.get('/next', Token.Auth, requireTenantOperational, requirePermission('px.tab.monitoring'), awaitHandlerFactory(TracingController.nextQuote));

router.post('/save', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('tracing.create'), awaitHandlerFactory(TracingController.SaveTracing));

router.put('/update', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('tracing.correct'), awaitHandlerFactory(TracingController.UpdateTracing));

router.post('/cancel', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('tracing.cancel'), awaitHandlerFactory(TracingController.DeleteTracing));
// Compatibility alias: only annuls, never physically deletes.
router.delete('/delete', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('tracing.cancel'), awaitHandlerFactory(TracingController.DeleteTracing));

module.exports = router; 

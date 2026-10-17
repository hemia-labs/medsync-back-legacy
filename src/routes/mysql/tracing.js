const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const TracingController = require('../../controller/mysql/tracing.controller');
const { requirePermission } = require('../../middleware/requirePermission.middleware');

const csrfProtected = csrfProtection();

router.get('/list/:id_person', Token.Auth, requireTenantOperational, requirePermission('px.tab.monitoring'), awaitHandlerFactory(TracingController.getTracing));
router.get('/patient/:id_person/:id_tracing/revisions', Token.Auth, requireTenantOperational, requirePermission('px.tab.monitoring'), awaitHandlerFactory(TracingController.revisions));

router.get('/next', Token.Auth, requireTenantOperational, requirePermission('px.tab.monitoring'), awaitHandlerFactory(TracingController.nextQuote));

router.post('/save', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('tracing.create'), awaitHandlerFactory(TracingController.SaveTracing));

router.put('/update', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('tracing.correct'), awaitHandlerFactory(TracingController.UpdateTracing));

router.post('/cancel', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('tracing.cancel'), awaitHandlerFactory(TracingController.DeleteTracing));
// Compatibility alias: only annuls, never physically deletes.
router.delete('/delete', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('tracing.cancel'), awaitHandlerFactory(TracingController.DeleteTracing));

module.exports = router; 

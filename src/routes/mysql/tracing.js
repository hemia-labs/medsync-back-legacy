const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const TracingController = require('../../controller/mysql/tracing.controller');

const csrfProtected = csrfProtection();

router.get('/list/:id_person', Token.Auth, requireTenantOperational, awaitHandlerFactory(TracingController.getTracing));

router.get('/next', Token.Auth, requireTenantOperational, awaitHandlerFactory(TracingController.nextQuote));

router.post('/save', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(TracingController.SaveTracing));

router.put('/update', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(TracingController.UpdateTracing));

router.delete('/delete', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(TracingController.DeleteTracing));

module.exports = router; 

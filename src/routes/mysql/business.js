const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const BusinessController = require('../../controller/mysql/business.controller');

const csrfProtected = csrfProtection();

router.get('/current', Token.Auth, requireTenantOperational, awaitHandlerFactory(BusinessController.current));
router.put('/current', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(BusinessController.updateCurrent));

module.exports = router;

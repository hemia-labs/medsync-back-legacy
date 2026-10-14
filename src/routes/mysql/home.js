const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const HomeContinuityController = require('../../controller/mysql/homeContinuity.controller');

router.get('/continuity-summary', Token.Auth, requireTenantOperational, awaitHandlerFactory(HomeContinuityController.summary));
router.get('/appointments', Token.Auth, requireTenantOperational, awaitHandlerFactory(HomeContinuityController.appointments));

module.exports = router;

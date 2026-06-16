const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const BusinessDashboardController = require('../../controller/mysql/businessDashboard.controller');

router.get('/trends', Token.Auth, requireTenantOperational, awaitHandlerFactory(BusinessDashboardController.trends));
router.get('/operational-summary', Token.Auth, requireTenantOperational, awaitHandlerFactory(BusinessDashboardController.operationalSummary));
router.get('/professional-breakdown', Token.Auth, requireTenantOperational, awaitHandlerFactory(BusinessDashboardController.professionalBreakdown));
router.get('/team-breakdown', Token.Auth, requireTenantOperational, awaitHandlerFactory(BusinessDashboardController.teamBreakdown));
router.get('/summary', Token.Auth, requireTenantOperational, awaitHandlerFactory(BusinessDashboardController.summary));

module.exports = router;

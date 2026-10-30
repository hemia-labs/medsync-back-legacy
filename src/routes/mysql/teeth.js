const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { requirePermission } = require('../../middleware/requirePermission.middleware');
const requireOdontogramScope = require('../../middleware/requireOdontogramScope.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const ToothController = require('../../controller/mysql/tooth.controller');
const requireClinicalPermission = requirePermission('px.tab.odontogram', { enabledCatalog: true });

router.get('/list/:person', Token.Auth, requireTenantOperational, requireClinicalPermission, requireOdontogramScope, awaitHandlerFactory(ToothController.getTeeth));

router.get('/list/:person/:code', Token.Auth, requireTenantOperational, requireClinicalPermission, requireOdontogramScope, awaitHandlerFactory(ToothController.getTeeth));

module.exports = router;

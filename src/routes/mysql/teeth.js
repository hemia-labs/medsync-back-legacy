const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const ToothController = require('../../controller/mysql/tooth.controller');

router.get('/list/:person', Token.Auth, requireTenantOperational, awaitHandlerFactory(ToothController.getTeeth));

router.get('/list/:person/:code', Token.Auth, requireTenantOperational, awaitHandlerFactory(ToothController.getTeeth));

module.exports = router; 
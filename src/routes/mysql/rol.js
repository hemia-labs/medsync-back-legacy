const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const RolController = require('../../controller/mysql/rol.controller');

const csrfProtected = csrfProtection();

router.get('/list', Token.Auth, requireTenantOperational, awaitHandlerFactory(RolController.getRoles));

router.get('/permissions/:id', Token.Auth, requireTenantOperational, awaitHandlerFactory(RolController.getPermissions));

router.put('/permissions/:id', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(RolController.savePermissions));

module.exports = router; 

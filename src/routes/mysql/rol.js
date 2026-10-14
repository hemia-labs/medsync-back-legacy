const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const RolController = require('../../controller/mysql/rol.controller');
const requireTenantAdministrator = require('../../middleware/requireTenantAdministrator.middleware');

const csrfProtected = csrfProtection();

router.get('/list', Token.Auth, requireTenantOperational, awaitHandlerFactory(RolController.getRoles));

router.get('/permissions/:id', Token.Auth, requireTenantOperational, requireTenantAdministrator('admin.users'), awaitHandlerFactory(RolController.getPermissions));

router.put('/permissions/:id', Token.Auth, csrfProtected, requireTenantOperational, requireTenantAdministrator('admin.users'), awaitHandlerFactory(RolController.savePermissions));

module.exports = router; 

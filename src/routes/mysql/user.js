const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { requirePermission, requireSelfOrPermission } = require('../../middleware/requirePermission.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const UserController = require('../../controller/mysql/user.controller');

const csrfProtected = csrfProtection();

router.post('/create', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('admin.users', { resource: 'user.create' }), awaitHandlerFactory(UserController.SaveUser));

router.get('/list', Token.Auth, requireTenantOperational, requirePermission('admin.users', { resource: 'user.list' }), awaitHandlerFactory(UserController.getUsers));

router.get('/list/:id', Token.Auth, requireTenantOperational, requirePermission('admin.users', { resource: 'user.detail' }), awaitHandlerFactory(UserController.getUsersbyId));

router.get('/professional-profile/me', Token.Auth, requireTenantOperational, awaitHandlerFactory(UserController.getProfessionalProfile));

router.get('/professional-profile/:id', Token.Auth, requireTenantOperational, requireSelfOrPermission('admin.users', { resource: 'user.professional_profile.view' }), awaitHandlerFactory(UserController.getProfessionalProfile));

router.post('/professional-profile/:id', Token.Auth, csrfProtected, requireTenantOperational, requireSelfOrPermission('admin.users', { resource: 'user.professional_profile.save' }), awaitHandlerFactory(UserController.saveProfessionalProfile));

router.put('/update/:id', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('admin.users', { resource: 'user.update' }), awaitHandlerFactory(UserController.UpdateUser));


module.exports = router; 

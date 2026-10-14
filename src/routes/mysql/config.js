const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const requireTenantAdministrator = require('../../middleware/requireTenantAdministrator.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const validatePayload = require('../../middleware/validatePayload.middleware');
const ConfigController = require('../../controller/mysql/config.controller');
const { validateLoginImageSave, validateThemeSave } = require('../../validators/config.validator');

const csrfProtected = csrfProtection();

router.post('/signatureconten/save', Token.Auth, csrfProtected, requireTenantOperational, requireTenantAdministrator('admin.config'), awaitHandlerFactory(ConfigController.signatureContentSave));

router.put('/signatureconten/update', Token.Auth, csrfProtected, requireTenantOperational, requireTenantAdministrator('admin.config'), awaitHandlerFactory(ConfigController.signatureContentUpdate));

router.get('/signatureconten/get', Token.Auth, requireTenantOperational, awaitHandlerFactory(ConfigController.signatureContentGet));

router.post('/login-image/save', Token.Auth, csrfProtected, requireTenantOperational, requireTenantAdministrator('admin.config'), validatePayload(validateLoginImageSave), awaitHandlerFactory(ConfigController.loginImageSave));

router.get('/login-image/get', Token.OptionalAuth, awaitHandlerFactory(ConfigController.loginImageGet));

router.get('/theme/list', awaitHandlerFactory(ConfigController.themeList));

router.get('/theme/get', Token.OptionalAuth, awaitHandlerFactory(ConfigController.themeGet));

router.post('/theme/save', Token.Auth, csrfProtected, requireTenantOperational, requireTenantAdministrator('admin.config'), validatePayload(validateThemeSave), awaitHandlerFactory(ConfigController.themeSave));

router.get('/clinical-modules/get', Token.Auth, requireTenantOperational, awaitHandlerFactory(ConfigController.clinicalModuleConfigGet));

router.post('/clinical-modules/save', Token.Auth, csrfProtected, requireTenantOperational, requireTenantAdministrator('admin.config'), awaitHandlerFactory(ConfigController.clinicalModuleConfigSave));

module.exports = router; 

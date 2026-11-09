const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const BusinessController = require('../../controller/mysql/business.controller');
const { requirePermission } = require('../../middleware/requirePermission.middleware');
const { validateBusinessUpdatePayload } = require('../../validators/business.validator');

const { protectedBodyParser } = require('../../middleware/requestBody.middleware');
const csrfProtected = csrfProtection();

router.get('/current', Token.Auth, requireTenantOperational, awaitHandlerFactory(BusinessController.current));
router.get('/preparation', Token.Auth, requireTenantOperational, awaitHandlerFactory(BusinessController.preparation));
router.get('/license-usage', Token.Auth, requireTenantOperational, requirePermission('admin.users', {resource:'user.license_usage'}), awaitHandlerFactory(BusinessController.licenseUsage));
router.put('/current', Token.Auth, csrfProtected, requireTenantOperational, validateBusinessUpdatePayload, awaitHandlerFactory(BusinessController.updateCurrent));

router.put('/current/logo', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('admin.config', {resource:'business.logo'}), protectedBodyParser, awaitHandlerFactory(BusinessController.updateLogo));
router.delete('/current/logo', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('admin.config', {resource:'business.logo'}), awaitHandlerFactory(BusinessController.updateLogo));
module.exports = router;

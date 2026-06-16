const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const validatePayload = require('../../middleware/validatePayload.middleware');
const ClinicalHistoryTemplateController = require('../../controller/mysql/clinicalHistoryTemplate.controller');
const {
    validateCreateBusinessTemplate,
    validateCreateVersion
} = require('../../validators/clinicalHistoryTemplate.validator');

const csrfProtected = csrfProtection();

router.get('/current', Token.Auth, requireTenantOperational, awaitHandlerFactory(ClinicalHistoryTemplateController.current));
router.post('/business', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateCreateBusinessTemplate), awaitHandlerFactory(ClinicalHistoryTemplateController.createBusinessTemplate));
router.post('/:templateId/version', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateCreateVersion), awaitHandlerFactory(ClinicalHistoryTemplateController.createVersion));

module.exports = router;

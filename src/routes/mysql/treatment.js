const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const validatePayload = require('../../middleware/validatePayload.middleware');
const TreatmentController = require('../../controller/mysql/treatment.controller');
const { requirePermission } = require('../../middleware/requirePermission.middleware');
const requireLegacyTreatmentScope = require('../../middleware/requireLegacyTreatmentScope.middleware');
const {
    validatePreparePlanConsent,
    validateSignPreparedConsent,
    validateDeleteTreatment,
    validateDeletePlanTreatment,
    validateCloseTreatmentPlan,
    validateCreateTreatmentPlan,
    validateUpdateTreatmentPlan,
    validateIdPersonParam,
    validateSaveDiagnosis,
    validateSavePlanConsent,
    validateSavePlanTreatment,
    validateSaveTreatment,
    validateUpdatePlanTreatmentStatus,
    validateUpdateTreatment
} = require('../../validators/treatment.validator');

const { protectedBodyParser } = require('../../middleware/requestBody.middleware');

const csrfProtected = csrfProtection();

router.get('/plan/:id_person', Token.Auth, requireTenantOperational, validatePayload(validateIdPersonParam), awaitHandlerFactory(TreatmentController.GetTreatmentPlan));
router.get('/plan/:id_person/doctors', Token.Auth, requireTenantOperational, validatePayload(validateIdPersonParam), awaitHandlerFactory(TreatmentController.GetSigningDoctors));

router.post('/plan/create', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateCreateTreatmentPlan), awaitHandlerFactory(TreatmentController.CreateTreatmentPlan));

router.post('/plan/update', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateUpdateTreatmentPlan), awaitHandlerFactory(TreatmentController.UpdateTreatmentPlan));

router.post('/plan/close', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateCloseTreatmentPlan), awaitHandlerFactory(TreatmentController.CloseTreatmentPlan));

router.post('/plan/treatment/save', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateSavePlanTreatment), awaitHandlerFactory(TreatmentController.SavePlanTreatment));

router.post('/plan/treatment/status', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateUpdatePlanTreatmentStatus), awaitHandlerFactory(TreatmentController.UpdatePlanTreatmentStatus));

router.delete('/plan/treatment/delete', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateDeletePlanTreatment), awaitHandlerFactory(TreatmentController.DeletePlanTreatment));

router.post('/plan/consent/save', Token.Auth, csrfProtected, requireTenantOperational, protectedBodyParser, validatePayload(validateSavePlanConsent), awaitHandlerFactory(TreatmentController.SavePlanConsent));
router.post('/plan/consent/prepare', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validatePreparePlanConsent), awaitHandlerFactory(TreatmentController.PrepareConsentDocument));
router.post('/plan/consent/document/sign', Token.Auth, csrfProtected, requireTenantOperational, protectedBodyParser, validatePayload(validateSignPreparedConsent), awaitHandlerFactory(TreatmentController.SignPreparedConsent));

// These compatibility responses contain monetary amounts. Both permissions are required.
router.get('/list/:id_person', Token.Auth, requireTenantOperational, requirePermission('treatments.view'), requirePermission('treatments.cost_view'), validatePayload(validateIdPersonParam), requireLegacyTreatmentScope, awaitHandlerFactory(TreatmentController.GetTreatment));

router.get('/cat/list/:id_person', Token.Auth, requireTenantOperational, validatePayload(validateIdPersonParam), awaitHandlerFactory(TreatmentController.CatTreatment));

router.post('/save', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('treatments.create'), requirePermission('treatments.cost_edit'), validatePayload(validateSaveTreatment), requireLegacyTreatmentScope, awaitHandlerFactory(TreatmentController.SaveTreatment));

router.put('/update', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('treatments.edit'), requirePermission('treatments.cost_edit'), validatePayload(validateUpdateTreatment), requireLegacyTreatmentScope, awaitHandlerFactory(TreatmentController.UpdateTreatment));

router.delete('/delete', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('treatments.cancel'), validatePayload(validateDeleteTreatment), requireLegacyTreatmentScope, awaitHandlerFactory(TreatmentController.DeleteTreatment));

router.get('/diagnosis/get/:id_person', Token.Auth, requireTenantOperational, requirePermission('treatments.view'), requirePermission('treatments.cost_view'), validatePayload(validateIdPersonParam), requireLegacyTreatmentScope, awaitHandlerFactory(TreatmentController.GetDiagnosis));

router.post('/diagnosis/save', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('treatments.edit'), requirePermission('treatments.cost_edit'), validatePayload(validateSaveDiagnosis), requireLegacyTreatmentScope, awaitHandlerFactory(TreatmentController.SaveDiagnosis));

module.exports = router; 

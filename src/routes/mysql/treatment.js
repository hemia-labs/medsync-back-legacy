const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const validatePayload = require('../../middleware/validatePayload.middleware');
const TreatmentController = require('../../controller/mysql/treatment.controller');
const {
    validateDeleteTreatment,
    validateDeletePlanTreatment,
    validateCloseTreatmentPlan,
    validateCreateTreatmentPlan,
    validateIdPersonParam,
    validateSaveDiagnosis,
    validateSavePlanConsent,
    validateSavePlanTreatment,
    validateSaveTreatment,
    validateUpdatePlanTreatmentStatus,
    validateUpdateTreatment
} = require('../../validators/treatment.validator');

const csrfProtected = csrfProtection();

router.get('/plan/:id_person', Token.Auth, requireTenantOperational, validatePayload(validateIdPersonParam), awaitHandlerFactory(TreatmentController.GetTreatmentPlan));

router.post('/plan/create', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateCreateTreatmentPlan), awaitHandlerFactory(TreatmentController.CreateTreatmentPlan));

router.post('/plan/close', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateCloseTreatmentPlan), awaitHandlerFactory(TreatmentController.CloseTreatmentPlan));

router.post('/plan/treatment/save', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateSavePlanTreatment), awaitHandlerFactory(TreatmentController.SavePlanTreatment));

router.post('/plan/treatment/status', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateUpdatePlanTreatmentStatus), awaitHandlerFactory(TreatmentController.UpdatePlanTreatmentStatus));

router.delete('/plan/treatment/delete', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateDeletePlanTreatment), awaitHandlerFactory(TreatmentController.DeletePlanTreatment));

router.post('/plan/consent/save', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateSavePlanConsent), awaitHandlerFactory(TreatmentController.SavePlanConsent));

router.get('/list/:id_person', Token.Auth, requireTenantOperational, validatePayload(validateIdPersonParam), awaitHandlerFactory(TreatmentController.GetTreatment));

router.get('/cat/list/:id_person', Token.Auth, requireTenantOperational, validatePayload(validateIdPersonParam), awaitHandlerFactory(TreatmentController.CatTreatment));

router.post('/save', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateSaveTreatment), awaitHandlerFactory(TreatmentController.SaveTreatment));

router.put('/update', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateUpdateTreatment), awaitHandlerFactory(TreatmentController.UpdateTreatment));

router.delete('/delete', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateDeleteTreatment), awaitHandlerFactory(TreatmentController.DeleteTreatment));

router.get('/diagnosis/get/:id_person', Token.Auth, requireTenantOperational, validatePayload(validateIdPersonParam), awaitHandlerFactory(TreatmentController.GetDiagnosis));

router.post('/diagnosis/save', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateSaveDiagnosis), awaitHandlerFactory(TreatmentController.SaveDiagnosis));

module.exports = router; 

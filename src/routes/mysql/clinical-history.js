const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const validatePayload = require('../../middleware/validatePayload.middleware');
const ClinicalHistoryController = require('../../controller/mysql/clinicalHistory.controller');
const {
    validatePatientParam,
    validateIdParam,
    validateDraftCreate,
    validateDraftUpdate
} = require('../../validators/clinicalHistory.validator');

const csrfProtected = csrfProtection();

router.get('/patient/:patientId/intake', Token.Auth, requireTenantOperational, validatePayload(validatePatientParam), awaitHandlerFactory(ClinicalHistoryController.getIntake));
router.put('/patient/:patientId/intake', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validatePatientParam), awaitHandlerFactory(ClinicalHistoryController.saveIntake));

router.get('/patient/:patientId/versions', Token.Auth, requireTenantOperational, validatePayload(validatePatientParam), awaitHandlerFactory(ClinicalHistoryController.versionsByPatient));
router.get('/patient/:patientId', Token.Auth, requireTenantOperational, validatePayload(validatePatientParam), awaitHandlerFactory(ClinicalHistoryController.latestByPatient));
router.post('/draft', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateDraftCreate), awaitHandlerFactory(ClinicalHistoryController.createDraft));
router.put('/:id/draft', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateDraftUpdate), awaitHandlerFactory(ClinicalHistoryController.updateDraft));
router.post('/:id/finalize', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateIdParam), awaitHandlerFactory(ClinicalHistoryController.finalize));
router.post('/:id/printed', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateIdParam), awaitHandlerFactory(ClinicalHistoryController.printed));
router.post('/:id/cancel', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateIdParam), awaitHandlerFactory(ClinicalHistoryController.cancel));
router.get('/:id', Token.Auth, requireTenantOperational, validatePayload(validateIdParam), awaitHandlerFactory(ClinicalHistoryController.getById));

module.exports = router;

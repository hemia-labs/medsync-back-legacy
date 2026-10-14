const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const validatePayload = require('../../middleware/validatePayload.middleware');
const PrescriptionController = require('../../controller/mysql/prescription.controller');
const {
    validateConfigSave,
    validatePrescriptionSave,
    validateIssue,
    validateCancel,
    validateDeleteDraft,
    validateAuditAction
} = require('../../validators/prescription.validator');

const csrfProtected = csrfProtection();

router.get('/config', Token.Auth, requireTenantOperational, awaitHandlerFactory(PrescriptionController.getConfig));

router.post('/config/save', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateConfigSave), awaitHandlerFactory(PrescriptionController.saveConfig));

router.get('/list', Token.Auth, requireTenantOperational, awaitHandlerFactory(PrescriptionController.list));

router.get('/patient/:id_person', Token.Auth, requireTenantOperational, awaitHandlerFactory(PrescriptionController.listByPatient));

router.get('/doctors', Token.Auth, requireTenantOperational, awaitHandlerFactory(PrescriptionController.doctors));

router.get('/:id_prescription', Token.Auth, requireTenantOperational, awaitHandlerFactory(PrescriptionController.getById));

router.post('/save', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validatePrescriptionSave), awaitHandlerFactory(PrescriptionController.save));

router.post('/issue', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateIssue), awaitHandlerFactory(PrescriptionController.issue));

router.post('/cancel', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateCancel), awaitHandlerFactory(PrescriptionController.cancel));

router.delete('/draft', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateDeleteDraft), awaitHandlerFactory(PrescriptionController.deleteDraft));

router.post('/audit-action', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateAuditAction), awaitHandlerFactory(PrescriptionController.auditAction));
router.post('/output', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateAuditAction), awaitHandlerFactory(PrescriptionController.prepareOutput));

module.exports = router;

const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const DocumentController = require('../../controller/mysql/document.controller');
const DocumentSignatureRequestController = require('../../controller/mysql/documentSignatureRequest.controller');

const { protectedBodyParser } = require('../../middleware/requestBody.middleware');

const csrfProtected = csrfProtection();

router.get('/templates', Token.Auth, requireTenantOperational, awaitHandlerFactory(DocumentController.Templates));
router.post('/template/save', Token.Auth, csrfProtected, requireTenantOperational, protectedBodyParser, awaitHandlerFactory(DocumentController.SaveTemplate));
router.post('/signature-request/create', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(DocumentSignatureRequestController.Create));
router.post('/signature-request/email', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(DocumentSignatureRequestController.Email));
router.get('/signature-request/list/:id_patient_document', Token.Auth, requireTenantOperational, awaitHandlerFactory(DocumentSignatureRequestController.List));
router.post('/signature-request/revoke', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(DocumentSignatureRequestController.Revoke));
router.get('/patient/:id_person', Token.Auth, requireTenantOperational, awaitHandlerFactory(DocumentController.PatientDocuments));
router.get('/patient/:id_person/:id_patient_document', Token.Auth, requireTenantOperational, awaitHandlerFactory(DocumentController.PatientDocuments));
router.post('/create', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(DocumentController.CreateDocument));
router.post('/sign', Token.Auth, csrfProtected, requireTenantOperational, protectedBodyParser, awaitHandlerFactory(DocumentController.SignDocument));
router.post('/refusal', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(DocumentController.RegisterRefusal));
router.post('/cancel', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(DocumentController.CancelDocument));
router.post('/audit-action', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(DocumentController.AuditAction));

module.exports = router;

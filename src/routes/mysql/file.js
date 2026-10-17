const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { requirePermission } = require('../../middleware/requirePermission.middleware');
const patientFileAccess = require('../../middleware/patientFileAccess.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const validatePayload = require('../../middleware/validatePayload.middleware');
const FilesController = require('../../controller/mysql/files.controller');
const {
    validateDeleteFile,
    validateGetFiles,
    validateUploadFile,
    validateUploadProfile
} = require('../../validators/file.validator');

const { protectedBodyParser } = require('../../middleware/requestBody.middleware');

const csrfProtected = csrfProtection();

router.get('/buckets', Token.Auth, requireTenantOperational, requirePermission('admin.config'), awaitHandlerFactory(FilesController.listBuckets));

router.get('/px/file/:px', Token.Auth, requireTenantOperational, patientFileAccess(), validatePayload(validateGetFiles), awaitHandlerFactory(FilesController.getfilesPhoto));

router.delete('/delete', Token.Auth, csrfProtected, requireTenantOperational, patientFileAccess(true), validatePayload(validateDeleteFile), awaitHandlerFactory(FilesController.deletefile));

router.post('/px/upload-file', Token.Auth, csrfProtected, requireTenantOperational, protectedBodyParser, patientFileAccess(true), validatePayload(validateUploadFile), awaitHandlerFactory(FilesController.uploadFile));

router.post('/px/upload-profile', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('px.new'), protectedBodyParser, validatePayload(validateUploadProfile), awaitHandlerFactory(FilesController.uploaProfilePhoto));

module.exports = router; 

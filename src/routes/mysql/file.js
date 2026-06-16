const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
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

const csrfProtected = csrfProtection();

router.get('/buckets', Token.Auth, requireTenantOperational, awaitHandlerFactory(FilesController.listBuckets));

router.get('/px/file/:px', Token.Auth, requireTenantOperational, validatePayload(validateGetFiles), awaitHandlerFactory(FilesController.getfilesPhoto));

router.delete('/delete', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateDeleteFile), awaitHandlerFactory(FilesController.deletefile));

router.post('/px/upload-file', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateUploadFile), awaitHandlerFactory(FilesController.uploadFile));

router.post('/px/upload-profile', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateUploadProfile), awaitHandlerFactory(FilesController.uploaProfilePhoto));

module.exports = router; 

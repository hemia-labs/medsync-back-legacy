const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const validatePayload = require('../../middleware/validatePayload.middleware');
const OdontogramController = require('../../controller/mysql/odontogram.controller');
const {
    validateDeleteOdontogram,
    validateGetTooth,
    validateIdPersonParam,
    validateSaveOdontogram,
    validateSaveOdontogramDetail,
    validateSaveTooth,
    validateStatusOdontogram,
    validateUpdateTooth
} = require('../../validators/odontogram.validator');

const csrfProtected = csrfProtection();

router.post('/save', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateSaveTooth), awaitHandlerFactory(OdontogramController.SaveTooth));

router.put('/update', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateUpdateTooth), awaitHandlerFactory(OdontogramController.UpdateTooth));

router.get('/get/tooth/:id_person/:id_tooth', Token.Auth, requireTenantOperational, validatePayload(validateGetTooth), awaitHandlerFactory(OdontogramController.getByidTooht));

router.get('/getcatypetooth', Token.Auth, requireTenantOperational, awaitHandlerFactory(OdontogramController.GetCatTypeTooth));

router.post('/v1/save', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateSaveOdontogram), awaitHandlerFactory(OdontogramController.saveOdontogramv1));

router.post('/v1/detail', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateSaveOdontogramDetail), awaitHandlerFactory(OdontogramController.saveOdontogramvDetailV1));

router.get('/v1/odontogram/:id_person', Token.Auth, requireTenantOperational, validatePayload(validateIdPersonParam), awaitHandlerFactory(OdontogramController.getOdontogram));

router.get('/v1/validate/:id_person', Token.Auth, requireTenantOperational, validatePayload(validateIdPersonParam), awaitHandlerFactory(OdontogramController.getValidator));

router.get('/v1/history/:id_person', Token.Auth, requireTenantOperational, validatePayload(validateIdPersonParam), awaitHandlerFactory(OdontogramController.getHistoryv1));

router.put('/v1/status', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateStatusOdontogram), awaitHandlerFactory(OdontogramController.updateStatusOdontogramV1));

router.delete('/v1/delete', Token.Auth, csrfProtected, requireTenantOperational, validatePayload(validateDeleteOdontogram), awaitHandlerFactory(OdontogramController.deleteOdontogramV1));

module.exports = router; 

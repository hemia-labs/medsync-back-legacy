const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { requirePermission } = require('../../middleware/requirePermission.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const validatePayload = require('../../middleware/validatePayload.middleware');
const PxController = require('../../controller/mysql/px.controller');
const {
    validatePxDelete,
    validatePxFastSearch,
    validatePxIdParam,
    validatePxCreateMinimal,
    validatePxSave,
    validatePxSearch,
    validatePxUpdate
} = require('../../validators/px.validator');

const { protectedBodyParser } = require('../../middleware/requestBody.middleware');

const csrfProtected = csrfProtection();

router.put('/allergies', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('clinical_history.edit_draft', { resource: 'px.allergies' }), awaitHandlerFactory(PxController.updateAllergies));

router.post('/create-minimal', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('px.new', { resource: 'px.create_minimal' }), validatePayload(validatePxCreateMinimal), awaitHandlerFactory(PxController.PxCreateMinimal));

router.post('/save', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('px.new', { resource: 'px.save' }), requirePermission('clinical_history.edit_draft', { resource: 'px.save_clinical' }), protectedBodyParser, validatePayload(validatePxSave), awaitHandlerFactory(PxController.PxSave));

router.put('/update', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('px.new', { resource: 'px.update' }), requirePermission('clinical_history.edit_draft', { resource: 'px.update_clinical' }), protectedBodyParser, validatePayload(validatePxUpdate), awaitHandlerFactory(PxController.PxUpdate));

router.put('/administrative', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('px.new', { resource: 'px.update_administrative' }), validatePayload(require('../../validators/px.validator').validatePxAdministrative), awaitHandlerFactory(PxController.updateAdministrative));

router.delete('/force-delete', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('px.new', { resource: 'px.force_delete' }), validatePayload(validatePxDelete), awaitHandlerFactory(PxController.pxForceDelete));

router.delete('/delete', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('px.new', { resource: 'px.delete' }), validatePayload(validatePxDelete), awaitHandlerFactory(PxController.pxDelete));

router.put('/restore', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('px.new', { resource: 'px.restore' }), validatePayload(validatePxDelete), awaitHandlerFactory(PxController.pxRestore));

router.post('/search-fast', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('px.all', { resource: 'px.search_fast' }), validatePayload(validatePxFastSearch), awaitHandlerFactory(PxController.getPxFastSearch));

router.post('/search', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('px.all', { resource: 'px.search' }), validatePayload(validatePxSearch), awaitHandlerFactory(PxController.getPxSearch));

router.get('/birthday', Token.Auth, requireTenantOperational, requirePermission('px.all', { resource: 'px.birthday' }), awaitHandlerFactory(PxController.getPxBithDay));

router.get('/family-path', Token.Auth, requireTenantOperational, requirePermission('px.all', { resource: 'px.family_path' }), awaitHandlerFactory(PxController.getFamilyPath));

router.get('/get/:id', Token.Auth, requireTenantOperational, requirePermission('px.all', { resource: 'px.get' }), validatePayload(validatePxIdParam), awaitHandlerFactory(PxController.getPxById));

module.exports = router; 

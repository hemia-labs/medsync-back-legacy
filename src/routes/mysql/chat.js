'use strict';
// NC5 · Chat interno por negocio. Cualquier colega activo puede usarlo; no concede permisos de Agenda ni de expediente.
const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const { requirePermission } = require('../../middleware/requirePermission.middleware');
const Chat = require('../../controller/mysql/chat.controller');

const csrfProtected = csrfProtection();
router.get('/directory', Token.Auth, requireTenantOperational, awaitHandlerFactory(Chat.directory));
router.get('/summary', Token.Auth, requireTenantOperational, awaitHandlerFactory(Chat.summary));
router.get('/conversations', Token.Auth, requireTenantOperational, awaitHandlerFactory(Chat.conversations));
router.get('/conversations/:peerId/messages', Token.Auth, requireTenantOperational, awaitHandlerFactory(Chat.messages));
router.post('/conversations/:peerId/read', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(Chat.markRead));
router.post('/messages', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(Chat.sendText));
router.post('/notices/preview', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(Chat.previewNotice));
router.post('/notices', Token.Auth, csrfProtected, requireTenantOperational, awaitHandlerFactory(Chat.sendNotice));
router.get('/requests/:clientRequestId', Token.Auth, requireTenantOperational, awaitHandlerFactory(Chat.request));
router.get('/notices/tracing/:tracingId', Token.Auth, requireTenantOperational, requirePermission('px.tab.monitoring'), awaitHandlerFactory(Chat.noticesForTracing));

module.exports = router;

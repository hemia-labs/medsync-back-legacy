const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { requireAnyPermission, requirePermission } = require('../../middleware/requirePermission.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const AppointmentController = require('../../controller/mysql/appointment.controller');

const csrfProtected = csrfProtection();

router.get('/config', Token.Auth, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.config.view' }), awaitHandlerFactory(AppointmentController.getConfig));

router.post('/config/save', Token.Auth, csrfProtected, requireTenantOperational, requirePermission('admin.config', { resource: 'appointment.config.save' }), awaitHandlerFactory(AppointmentController.saveConfig));

router.get('/patient/:patientId/history', Token.Auth, requireTenantOperational, requireAnyPermission(['px.tab.monitoring', 'px.dates', 'admin.config'], { resource: 'appointment.patient.history' }), awaitHandlerFactory(AppointmentController.patientHistory));

router.get('/list', Token.Auth, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.list' }), awaitHandlerFactory(AppointmentController.list));

router.post('/save', Token.Auth, csrfProtected, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.save' }), awaitHandlerFactory(AppointmentController.save));

router.delete('/delete', Token.Auth, csrfProtected, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.delete' }), awaitHandlerFactory(AppointmentController.delete));

module.exports = router;

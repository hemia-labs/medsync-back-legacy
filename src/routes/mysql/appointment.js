const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { requireAnyPermission, requirePermission } = require('../../middleware/requirePermission.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const AppointmentController = require('../../controller/mysql/appointment.controller');

const csrfProtected = csrfProtection();
router.get('/follow-ups', Token.Auth, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config']), requirePermission('px.tab.monitoring'), awaitHandlerFactory(AppointmentController.followUps));
router.post('/:appointmentId/link-patient', Token.Auth, csrfProtected, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config']), requirePermission('px.all'), awaitHandlerFactory(AppointmentController.linkPatient));
router.get('/patient/:patientId/follow-ups', Token.Auth, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config']), requirePermission('px.tab.monitoring'), awaitHandlerFactory(AppointmentController.followUps));

router.get('/doctors', Token.Auth, requireTenantOperational, requireAnyPermission(['px.dates', 'px.tab.monitoring', 'admin.config'], { resource: 'appointment.doctors' }), awaitHandlerFactory(AppointmentController.doctors));

router.get('/config', Token.Auth, requireTenantOperational, requireAnyPermission(['px.dates', 'px.tab.monitoring', 'admin.config'], { resource: 'appointment.config.view' }), awaitHandlerFactory(AppointmentController.getConfig));

router.post('/config/save', Token.Auth, csrfProtected, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.config.save' }), awaitHandlerFactory(AppointmentController.saveConfig));

router.post('/config/timezone', Token.Auth, csrfProtected, requireTenantOperational, requireAnyPermission(['admin.config'], { resource: 'appointment.config.timezone' }), awaitHandlerFactory(AppointmentController.saveTimezone));

router.get('/patient/:patientId/history', Token.Auth, requireTenantOperational, requireAnyPermission(['px.tab.monitoring', 'px.dates', 'admin.config'], { resource: 'appointment.patient.history' }), awaitHandlerFactory(AppointmentController.patientHistory));

router.get('/list', Token.Auth, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.list' }), awaitHandlerFactory(AppointmentController.list));

router.post('/save', Token.Auth, csrfProtected, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.save' }), awaitHandlerFactory(AppointmentController.save));

router.delete('/delete', Token.Auth, csrfProtected, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.delete' }), awaitHandlerFactory(AppointmentController.delete));

router.post('/reschedule', Token.Auth, csrfProtected, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.reschedule' }), awaitHandlerFactory(AppointmentController.reschedule));
router.post('/config/impact', Token.Auth, csrfProtected, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.config.impact' }), awaitHandlerFactory(AppointmentController.configImpact));
router.get('/:appointmentId/audit', Token.Auth, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.audit' }), awaitHandlerFactory(AppointmentController.audit));
router.get('/:appointmentId/cancellation-impact', Token.Auth, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.cancellation.impact' }), awaitHandlerFactory(AppointmentController.cancellationImpact));
router.get('/:appointmentId', Token.Auth, requireTenantOperational, requireAnyPermission(['px.dates', 'admin.config'], { resource: 'appointment.get' }), awaitHandlerFactory(AppointmentController.get));
module.exports = router;

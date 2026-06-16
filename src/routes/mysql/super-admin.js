const router = require('express').Router();
const Token = require('../../auth/authenticate');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const requireRole = require('../../middleware/requireRole.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const SuperAdminController = require('../../controller/mysql/superAdmin.controller');

const csrfProtected = csrfProtection();

router.get('/audit', Token.Auth, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.audit));
router.get('/dashboard/summary', Token.Auth, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.dashboardSummary));
router.get('/jobs/saas/status', Token.Auth, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.saasJobsStatus));
router.post('/jobs/saas/trial-lifecycle/run', Token.Auth, csrfProtected, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.runSaasTrialLifecycleJob));
router.get('/plans', Token.Auth, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.plans));
router.get('/businesses', Token.Auth, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.businesses));
router.get('/businesses/:id/license-summary', Token.Auth, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.businessLicenseSummary));
router.get('/businesses/:id/license-overrides', Token.Auth, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.businessLicenseOverrides));
router.post('/businesses', Token.Auth, csrfProtected, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.createBusiness));
router.patch('/businesses/:id', Token.Auth, csrfProtected, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.updateBusiness));
router.patch('/businesses/:id/license-overrides', Token.Auth, csrfProtected, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.updateBusinessLicenseOverrides));
router.patch('/businesses/:id/subscription-status', Token.Auth, csrfProtected, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.updateBusinessSubscriptionStatus));
router.patch('/businesses/:id/trial/extend', Token.Auth, csrfProtected, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.extendBusinessTrial));
router.patch('/businesses/:id/plan', Token.Auth, csrfProtected, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.updateBusinessPlan));
router.get('/users', Token.Auth, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.users));
router.get('/sessions', Token.Auth, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.sessions));
router.patch('/sessions/:id/close', Token.Auth, csrfProtected, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.closeSession));
router.patch('/users/:id/close-sessions', Token.Auth, csrfProtected, requireRole('super_admin'), awaitHandlerFactory(SuperAdminController.closeUserSessions));

module.exports = router;

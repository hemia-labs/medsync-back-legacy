const router = require('express').Router();
const Token = require('../../auth/authenticate');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const AuthController = require('../../controller/mysql/auth.controller');
const authRateLimit = require('../../middleware/authRateLimit.middleware');
const { validateAuthPayload } = require('../../middleware/authPayloadValidation.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');

const csrfAuthEndpoint = csrfProtection();

router.get('/csrf', Token.OptionalAuth, AuthController.csrf);

router.post('/login', csrfAuthEndpoint, validateAuthPayload('login'), authRateLimit('login'), awaitHandlerFactory(AuthController.login));

router.get('/session', Token.OptionalAuth, AuthController.session);

router.put('/close', Token.Auth, csrfAuthEndpoint, awaitHandlerFactory(AuthController.close));

router.put('/forze-close', Token.Auth, csrfAuthEndpoint, awaitHandlerFactory(AuthController.forze_close));

router.post('/refreshToken', Token.OptionalAuth, csrfAuthEndpoint, validateAuthPayload('refreshToken'), awaitHandlerFactory(AuthController.refreshToken));

router.post('/sendOtp', csrfAuthEndpoint, validateAuthPayload('sendOtp'), authRateLimit('sendOtp'), awaitHandlerFactory(AuthController.sendOtpRecoverPassword));

router.post('/validateOtp', csrfAuthEndpoint, validateAuthPayload('validateOtp'), authRateLimit('validateOtp'), awaitHandlerFactory(AuthController.validateOtp));

router.put('/resetPassword', csrfAuthEndpoint, validateAuthPayload('resetPassword'), authRateLimit('resetPassword'), awaitHandlerFactory(AuthController.ressetPassword));

router.post('/changePassword/sendCode', Token.Auth, csrfAuthEndpoint, validateAuthPayload('requestPasswordChangeCode'), authRateLimit('requestPasswordChangeCode'), awaitHandlerFactory(AuthController.requestPasswordChangeCode));

router.post('/changePassword/confirm', Token.Auth, csrfAuthEndpoint, validateAuthPayload('confirmPasswordChange'), authRateLimit('confirmPasswordChange'), awaitHandlerFactory(AuthController.confirmPasswordChange));

module.exports = router; 

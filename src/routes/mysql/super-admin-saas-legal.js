const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireRole = require('../../middleware/requireRole.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandler = require('../../middleware/awaitHandlerFactory.middleware');
const controller = require('../../controller/mysql/saasLegal.controller');

router.use(Token.Auth, requireRole('super_admin'));
router.get('/', awaitHandler(controller.adminList));
router.put('/:documentKey', csrfProtection(), awaitHandler(controller.saveDraft));
router.post('/:documentKey/publish', csrfProtection(), awaitHandler(controller.publish));
router.get('/:documentKey/versions/:idVersion', awaitHandler(controller.adminVersion));
module.exports = router;

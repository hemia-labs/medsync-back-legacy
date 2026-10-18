const router = require('express').Router();
const Token = require('../../auth/authenticate');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandler = require('../../middleware/awaitHandlerFactory.middleware');
const controller = require('../../controller/mysql/saasLegal.controller');

router.get('/public/:documentKey', awaitHandler(controller.publicDocument));
// Legal information stays available to authenticated members of expired or
// restricted tenants. The DAO still revalidates actor/tenant membership.
router.use(Token.Auth);
router.get('/', awaitHandler(controller.current));
router.get('/history', awaitHandler(controller.history));
router.post('/accept', csrfProtection(), awaitHandler(controller.accept));
module.exports = router;

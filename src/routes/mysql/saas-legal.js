const router = require('express').Router();
const Token = require('../../auth/authenticate');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const awaitHandler = require('../../middleware/awaitHandlerFactory.middleware');
const controller = require('../../controller/mysql/saasLegal.controller');

router.get('/public/:documentKey', awaitHandler(controller.publicDocument));
router.post('/integration/context', awaitHandler(controller.representativeContext));
// Legal information stays available to authenticated members of expired or
// restricted tenants. The DAO still revalidates actor/tenant membership.
router.use(Token.Auth);
router.get('/', awaitHandler(controller.current));
router.get('/notice', awaitHandler(controller.notice));
router.get('/history', awaitHandler(controller.history));
router.get('/central/context', awaitHandler(controller.centralContext));
router.post('/central/accept', csrfProtection(), awaitHandler(controller.acceptCentral));
router.get('/central/documents/:versionId', awaitHandler(controller.centralDocument));
router.post('/accept', csrfProtection(), awaitHandler(controller.accept));
module.exports = router;

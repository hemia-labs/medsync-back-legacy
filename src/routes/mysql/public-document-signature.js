const router = require('express').Router();
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const noStore = require('../../middleware/noStore.middleware');
const publicRateLimit = require('../../middleware/publicRateLimit.middleware');
const PublicDocumentSignatureController = require('../../controller/mysql/publicDocumentSignature.controller');

function positiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.floor(parsed);
}

const maxKeys = positiveInt(process.env.SIGNATURE_PUBLIC_RATE_LIMIT_MAX_KEYS, 10000);

const publicSignatureGetRateLimit = publicRateLimit({
    keyPrefix: 'public-document-signature-get',
    windowMs: positiveInt(process.env.SIGNATURE_PUBLIC_GET_RATE_LIMIT_WINDOW_MINUTES, 10) * 60 * 1000,
    maxRequests: positiveInt(process.env.SIGNATURE_PUBLIC_GET_RATE_LIMIT_MAX, 60),
    maxKeys
});

const publicSignatureSignRateLimit = publicRateLimit({
    keyPrefix: 'public-document-signature-sign',
    windowMs: positiveInt(process.env.SIGNATURE_PUBLIC_SIGN_RATE_LIMIT_WINDOW_MINUTES, 10) * 60 * 1000,
    maxRequests: positiveInt(process.env.SIGNATURE_PUBLIC_SIGN_RATE_LIMIT_MAX, 10),
    maxKeys
});

router.use(noStore);

router.get('/:token', publicSignatureGetRateLimit, awaitHandlerFactory(PublicDocumentSignatureController.Get));
router.post('/:token/sign', publicSignatureSignRateLimit, awaitHandlerFactory(PublicDocumentSignatureController.Sign));

module.exports = router;

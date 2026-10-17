'use strict';

// Read-only preflight before accepting an image. The signing transaction still
// revalidates the document, expiry, revocation and single-use token under lock.
module.exports = async function publicSignatureBodyAccess(req, res, next) {
    const unavailable = () => res.status(400).json({
        status: 400, success: false, data: null, code: 'SIGNATURE_LINK_NOT_AVAILABLE',
        message: 'Este enlace ya no esta disponible. Solicita uno nuevo al consultorio.'
    });
    const token = String(req.params.token || '').trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return unavailable();
    try {
        const dao = require('../Dao/mysql/publicDocumentSignature.dao');
        const { hashToken } = require('../services/documentSignature/documentSignatureToken.service');
        const request = await dao.getRequestByHash(hashToken(token));
        if (!dao.requestIsAvailable(request) || dao.requestIsExpired(request)) return unavailable();
        req.signatureBodyAuthorized = true;
        return next();
    } catch (error) { return next(error); }
};

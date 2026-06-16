const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const MESSAGES = require('../../util/common.messages.util');
const PublicDocumentSignatureDao = require('../../Dao/mysql/publicDocumentSignature.dao');

function requestMeta(req) {
    return {
        ip: req.ip ||
            (req.socket && req.socket.remoteAddress) ||
            (req.connection && req.connection.remoteAddress) ||
            null,
        userAgent: req.headers['user-agent'] || null
    };
}

class PublicDocumentSignatureController extends httpResponseHelper {
    Get = async(req, res, next) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PublicDocumentSignatureDao.openByToken(req.params.token, requestMeta(req));
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    Sign = async(req, res, next) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PublicDocumentSignatureDao.signByToken(req.params.token, req.body || {}, requestMeta(req));
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }
}

module.exports = new PublicDocumentSignatureController();

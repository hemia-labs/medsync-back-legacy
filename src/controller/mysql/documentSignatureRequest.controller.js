const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const DocumentSignatureRequestDao = require('../../Dao/mysql/documentSignatureRequest.dao');
const { applyTenantToBody } = require('../../util/tenant');

class DocumentSignatureRequestController extends httpResponseHelper {
    Create = async(req, res, next) => {
        const body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentSignatureRequestDao.create(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    List = async(req, res, next) => {
        const body = applyTenantToBody(req, { id_patient_document: req.params.id_patient_document });
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentSignatureRequestDao.list(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    Revoke = async(req, res, next) => {
        const body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentSignatureRequestDao.revoke(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    Email = async(req, res, next) => {
        const body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentSignatureRequestDao.sendEmail(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }
}

module.exports = new DocumentSignatureRequestController();

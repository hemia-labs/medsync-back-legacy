const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const DocumentDao = require('../../Dao/mysql/document.dao');
const { applyTenantToBody } = require('../../util/tenant');

class DocumentController extends httpResponseHelper {
    Templates = async(req, res, next) => {
        let _body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentDao.listTemplates(_body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    SaveTemplate = async(req, res, next) => {
        let _body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentDao.saveTemplate(_body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    PatientDocuments = async(req, res, next) => {
        let _body = applyTenantToBody(req, { id_person: req.params.id_person });
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentDao.listPatientDocuments(_body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    CreateDocument = async(req, res, next) => {
        let _body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentDao.createDocument(_body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    SignDocument = async(req, res, next) => {
        let _body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentDao.updateStatus(_body, 'FIRMADO', 'SIGNED', 'Documento firmado.');
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    RegisterRefusal = async(req, res, next) => {
        let _body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentDao.updateStatus(_body, 'NO_FIRMADO_POR_NEGATIVA', 'REFUSAL_REGISTERED', _body.refusal_reason || 'Negativa de firma.');
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    CancelDocument = async(req, res, next) => {
        let _body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentDao.updateStatus(_body, 'CANCELADO', 'CANCELLED', _body.reason || 'Documento cancelado.');
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    AuditAction = async(req, res, next) => {
        let _body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await DocumentDao.auditAction(_body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }
}

module.exports = new DocumentController();

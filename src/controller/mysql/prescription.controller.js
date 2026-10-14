const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const PrescriptionDao = require('../../Dao/mysql/prescription.dao');
const { applyTenantToBody, getBusinessIdFromToken } = require('../../util/tenant');

class PrescriptionController extends httpResponseHelper {
    getConfig = async (req, res, next) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.getConfig(getBusinessIdFromToken(req.tokenDecode), req.query.doctor_profile_id, req.tokenDecode.id_login);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    saveConfig = async (req, res, next) => {
        const body = applyTenantToBody(req, req.body);
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.saveConfig(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    list = async (req, res, next) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.list({
                ...(req.query || {}),
                id_login: req.tokenDecode ? req.tokenDecode.id_login : null,
                id_business: getBusinessIdFromToken(req.tokenDecode)
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    listByPatient = async (req, res, next) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.list({
                ...(req.query || {}),
                id_person: req.params.id_person,
                id_login: req.tokenDecode ? req.tokenDecode.id_login : null,
                id_business: getBusinessIdFromToken(req.tokenDecode)
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    getById = async (req, res, next) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.getById({
                id_prescription: req.params.id_prescription,
                id_login: req.tokenDecode ? req.tokenDecode.id_login : null,
                id_business: getBusinessIdFromToken(req.tokenDecode)
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    save = async (req, res, next) => {
        const body = applyTenantToBody(req, req.body);
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.save(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    issue = async (req, res, next) => {
        const body = applyTenantToBody(req, req.body);
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.issue(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    cancel = async (req, res, next) => {
        const body = applyTenantToBody(req, req.body);
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.cancel(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    deleteDraft = async (req, res, next) => {
        const body = applyTenantToBody(req, req.body);
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.deleteDraft(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    auditAction = async (req, res, next) => {
        const body = applyTenantToBody(req, req.body);
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.auditAction(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    prepareOutput = async (req, res) => {
        const response = await PrescriptionDao.prepareOutput(applyTenantToBody(req, req.body));
        res.set('Cache-Control', 'no-store');
        res.status(response.status).send(response);
    }

    doctors = async (req, res, next) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await PrescriptionDao.doctors(getBusinessIdFromToken(req.tokenDecode));
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }
}

module.exports = new PrescriptionController();

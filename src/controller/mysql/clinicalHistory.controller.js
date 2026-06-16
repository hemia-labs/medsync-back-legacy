const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const ClinicalHistoryDao = require('../../Dao/mysql/clinicalHistory.dao');
const { applyTenantToBody, getBusinessIdFromToken } = require('../../util/tenant');

class ClinicalHistoryController extends httpResponseHelper {
    latestByPatient = async (req, res, next) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await ClinicalHistoryDao.getLatestByPatient({
                patient_id: req.params.patientId,
                id_login: req.tokenDecode ? req.tokenDecode.id_login : null,
                id_business: getBusinessIdFromToken(req.tokenDecode)
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    versionsByPatient = async (req, res, next) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await ClinicalHistoryDao.listVersionsByPatient({
                patient_id: req.params.patientId,
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
            response = await ClinicalHistoryDao.getById({
                id_clinical_history: req.params.id,
                id_login: req.tokenDecode ? req.tokenDecode.id_login : null,
                id_business: getBusinessIdFromToken(req.tokenDecode)
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    createDraft = async (req, res, next) => {
        const body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await ClinicalHistoryDao.createDraft(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    updateDraft = async (req, res, next) => {
        const body = applyTenantToBody(req, {
            ...(req.body || {}),
            id_clinical_history: req.params.id
        });
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await ClinicalHistoryDao.updateDraft(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    finalize = async (req, res, next) => {
        const body = applyTenantToBody(req, {
            ...(req.body || {}),
            id_clinical_history: req.params.id
        });
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await ClinicalHistoryDao.finalize(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    printed = async (req, res, next) => {
        const body = applyTenantToBody(req, {
            ...(req.body || {}),
            id_clinical_history: req.params.id
        });
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await ClinicalHistoryDao.markPrinted(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    cancel = async (req, res, next) => {
        const body = applyTenantToBody(req, {
            ...(req.body || {}),
            id_clinical_history: req.params.id
        });
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await ClinicalHistoryDao.cancel(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }
}

module.exports = new ClinicalHistoryController();

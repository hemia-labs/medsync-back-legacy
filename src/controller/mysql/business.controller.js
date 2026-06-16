const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const BusinessDao = require('../../Dao/mysql/business.dao');
const { getBusinessIdFromToken } = require('../../util/tenant');

class BusinessController extends httpResponseHelper {
    current = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await BusinessDao.get(getBusinessIdFromToken(req.tokenDecode));
            if (response && response.data && req.tenantOperational) {
                response.data.tenantOperational = req.tenantOperational;
                response.data.tenantOperationalMessage = req.tenantOperationalMessage || null;
            }
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    updateCurrent = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            const canConfig = await BusinessDao.hasPermission(req.tokenDecode ? req.tokenDecode.id_login : null, 'admin.config');
            if (!canConfig) {
                response = this.HttpError(HttpStatus.UNAUTHORIZED, 'No tienes permiso para modificar informacion del consultorio.');
                res.status(response.status).send(response);
                return;
            }

            const body = req.body || {};
            body.id_login = req.tokenDecode ? req.tokenDecode.id_login : null;
            response = await BusinessDao.update(getBusinessIdFromToken(req.tokenDecode), body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }
}

module.exports = new BusinessController();

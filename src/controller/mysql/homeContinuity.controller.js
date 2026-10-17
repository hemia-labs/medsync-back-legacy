const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const HomeContinuityDao = require('../../Dao/mysql/homeContinuity.dao');
const { getBusinessIdFromToken } = require('../../util/tenant');

class HomeContinuityController extends httpResponseHelper {
    summary = async(req, res, next) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await HomeContinuityDao.summary(
                getBusinessIdFromToken(req.tokenDecode),
                req.tokenDecode ? req.tokenDecode.id_login : null,
                { scope: req.query.scope }
            );
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    appointments = async(req, res) => {
        const response = await HomeContinuityDao.appointments(
            getBusinessIdFromToken(req.tokenDecode), req.tokenDecode.id_login,
            { scope: req.query.scope, date: req.query.date }
        );
        res.status(response.status).send(response);
    }
}

module.exports = new HomeContinuityController();

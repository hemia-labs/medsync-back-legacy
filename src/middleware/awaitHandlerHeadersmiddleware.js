const SessionDao = require('../Dao/mysql/session.Dao.js');
const HttpResponseHelper = require('../util/httpResponse');
const httpResponseHelper = new HttpResponseHelper();
const MESSAGES = require('../util/common.messages.util');
const HttpStatus = require('../util/httpStatusCode');

/**
 * Middleware que intercepta la peticion del servicio
 * @param {any} middleware EndPoint
 * @param {*} isauth Determina, si validara el token
 * @returns 
 */
const awaitHandlerHeadersFactory = (middleware) => {
    return async (req) => {
        try {

        await middleware(req);

        } catch (error) {
            next(error);
        }
    }
}

module.exports = awaitHandlerHeadersFactory;
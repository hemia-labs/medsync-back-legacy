const SessionDao = require('../Dao/mysql/session.Dao.js');
const HttpResponseHelper = require('../util/httpResponse');
const httpResponseHelper = new HttpResponseHelper();
const MESSAGES = require('../util/common.messages.util');
const HttpStatus = require('../util/httpStatusCode');
const SecurityConfig = require('../config/security');
const securityLogger = require('../services/security/securityLogger.service');

/**
 * Middleware que intercepta la peticion del servicio
 * @param {any} middleware EndPoint
 * @param {*} isauth Determina, si validara el token
 * @returns 
 */
const awaitHandlerFactory = (middleware, isAuth = true) => {
    return async (req, res, next) => {
        try {

            if( SecurityConfig.isActiveSessionRequired() && req.tokenDecode ) {/*La ruta previa ya fue validada, determinar el uso del middleware */
                 let response = httpResponseHelper.HttpNotAutorized(HttpStatus.UNAUTHORIZED, MESSAGES.UNAUTHORIZED)
                 if(!req.tokenDecode.id_login || !req.tokenDecode.id_session) {
                    securityLogger.record('auth.session.revoked_access_attempt', req, {
                        id_login: req.tokenDecode.id_login || null,
                        id_session_present: Boolean(req.tokenDecode.id_session),
                        reason: 'missing_session_claims'
                    });
                    res.status(HttpStatus.UNAUTHORIZED).send(response);
                    return;
                 }

                 const token = await SessionDao.checkActiveSession(req.tokenDecode.id_login, req.tokenDecode.id_session);

                 if(!token){
                    securityLogger.record('auth.session.revoked_access_attempt', req, {
                        id_login: req.tokenDecode.id_login,
                        id_session_present: true,
                        reason: 'inactive_or_revoked_session'
                    });
                    res.status(HttpStatus.UNAUTHORIZED).send(response);
                    return;
                 }
            }
            await middleware(req, res, next);
        } catch (error) {
            next(error);
        }
    }
}

module.exports = awaitHandlerFactory;

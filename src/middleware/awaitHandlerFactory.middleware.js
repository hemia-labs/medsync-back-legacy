const SessionDao = require('../Dao/mysql/session.Dao.js');
const responseData = require('../util/responsedata');
const MESSAGES = require('../util/common.messages.util');
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
                 // NC1-AUTH-S1: a missing or revoked session is identifiable by the client (data.code).
                 // A failed check (DB/network) throws and goes to next(error): it is never reported as a revocation.
                 const response = responseData.unauthorized(MESSAGES.UNAUTHORIZED, { code: 'AUTH_SESSION_INVALID' });
                 if(!req.tokenDecode.id_login || !req.tokenDecode.id_session) {
                    securityLogger.record('auth.session.revoked_access_attempt', req, {
                        id_login: req.tokenDecode.id_login || null,
                        id_session_present: Boolean(req.tokenDecode.id_session),
                        reason: 'missing_session_claims'
                    });
                    res.status(response.status).send(response);
                    return;
                 }

                 const token = await SessionDao.checkActiveSession(req.tokenDecode.id_login, req.tokenDecode.id_session);

                 if(!token){
                    securityLogger.record('auth.session.revoked_access_attempt', req, {
                        id_login: req.tokenDecode.id_login,
                        id_session_present: true,
                        reason: 'inactive_or_revoked_session'
                    });
                    res.status(response.status).send(response);
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

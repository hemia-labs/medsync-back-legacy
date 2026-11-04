const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const AuthDao = require('../../Dao/mysql/auth.dao');
const jwt = require('jsonwebtoken');
const AuthCookieConfig = require('../../config/authCookie.config');
const SecurityConfig = require('../../config/security');
const CsrfTokenService = require('../../services/security/csrfToken.service');
const { setHeaders } = require('../../util/headers');
const responseData = require('../../util/responsedata');
const securityLogger = require('../../services/security/securityLogger.service');
const {
    GENERIC_LOGIN_ERROR,
    GENERIC_RECOVERY_RESPONSE,
    GENERIC_OTP_ERROR,
    GENERIC_RESET_ERROR,
    GENERIC_REFRESH_ERROR,
    RATE_LIMIT_ERROR
} = require('../../util/authSecurityMessages');

function isSuccess(response) {
    return response && Number(response.status) >= 200 && Number(response.status) < 300;
}

function genericNotSuccess(message) {
    return responseData.notSuccess(message);
}

function recordSecurityEvent(req, securityEvent, fallbackEvent, extra = {}) {
    const metadata = {
        ...(securityEvent || {}),
        ...extra
    };
    const event = metadata.event || fallbackEvent;
    delete metadata.event;

    securityLogger.record(event, req, metadata);
}

function rateLimited(retryAfterSeconds) {
    return {
        status: 429,
        success: false,
        code: 'AUTH_RATE_LIMITED',
        data: null,
        retryAfterSeconds: retryAfterSeconds || null,
        message: RATE_LIMIT_ERROR
    };
}

function hasD2BrowserCookieAuth() {
    return AuthCookieConfig.getAuthCookieConfig().isCookieAuthEnabled;
}

function decodeAccessToken(accessToken) {
    return accessToken ? jwt.decode(accessToken) || {} : {};
}

function buildD2AuthResponseData(data) {
    const decoded = decodeAccessToken(data ? data.token : null);
    const accessExpiresAt = decoded.exp
        ? new Date(decoded.exp * 1000).toISOString()
        : null;
    const business = decoded.id_business ? {
        id_business: decoded.id_business,
        name: decoded.business_name || null,
        slug: decoded.business_slug || null,
        status: decoded.business_status || null
    } : null;

    return {
        authenticated: true,
        user: {
            id_login: decoded.id_login || null,
            id_session: decoded.id_session || null,
            id_business: decoded.id_business || null,
            id_rol: decoded.id_rol || null,
            rol: decoded.rol || null,
            name: decoded.name || null,
            email: decoded.email || null,
            telephone: decoded.telephone || null
        },
        role: {
            id_rol: decoded.id_rol || null,
            code: decoded.rol || null
        },
        permissions: Array.isArray(data && data.permisos) ? data.permisos : [],
        business,
        tenantOperational: data ? data.tenantOperational || null : null,
        tenantOperationalMessage: data ? data.tenantOperationalMessage || null : null,
        accessExpiresAt,
        sessionState: 'active'
    };
}

function applyD2LoginCookies(response, res) {
    if (!response || !response.data) {
        return response;
    }

    const data = response.data;
    const accessToken = data.token;
    const refreshToken = data.refresh_token;

    if (!accessToken) {
        throw new Error('D2 login cookie mode requires an access token from legacy login flow.');
    }

    const config = AuthCookieConfig.assertAuthCookieConfig();
    const names = AuthCookieConfig.getCookieNames(config);

    res.cookie(names.access, accessToken, AuthCookieConfig.getAccessCookieOptions(config));

    if (refreshToken) {
        res.cookie(names.refresh, refreshToken, AuthCookieConfig.getRefreshCookieOptions(config));
    }

    response.data = buildD2AuthResponseData(data);
    return response;
}

function applyD2RefreshCookies(response, res) {
    if (!response || !response.data) {
        return response;
    }

    const data = response.data;
    const accessToken = data.token;
    const refreshToken = data.refresh_token;

    if (!accessToken || !refreshToken) {
        throw new Error('D2 refresh cookie mode requires rotated access and refresh tokens from refresh flow.');
    }

    const config = AuthCookieConfig.assertAuthCookieConfig();
    const names = AuthCookieConfig.getCookieNames(config);

    res.cookie(names.access, accessToken, AuthCookieConfig.getAccessCookieOptions(config));
    res.cookie(names.refresh, refreshToken, AuthCookieConfig.getRefreshCookieOptions(config));

    response.data = buildD2AuthResponseData(data);
    return response;
}

function getD2RefreshRequestBody(req) {
    const config = AuthCookieConfig.assertAuthCookieConfig();
    const names = AuthCookieConfig.getCookieNames(config);
    const refreshToken = req && req.cookies ? req.cookies[names.refresh] : null;

    return {
        body: {
            id_refresh_token: refreshToken || null
        },
        hasRefreshToken: Boolean(refreshToken)
    };
}

function clearD2AuthCookies(res) {
    const config = AuthCookieConfig.assertAuthCookieConfig();
    const names = AuthCookieConfig.getCookieNames(config);

    res.cookie(names.access, '', AuthCookieConfig.getClearAccessCookieOptions(config));
    res.cookie(names.refresh, '', AuthCookieConfig.getClearRefreshCookieOptions(config));
    res.cookie(names.csrf, '', AuthCookieConfig.getClearCsrfCookieOptions(config));
}

function clearD2AuthCookiesBestEffort(req, res, eventName) {
    if (!hasD2BrowserCookieAuth()) {
        return;
    }

    try {
        clearD2AuthCookies(res);
    } catch (error) {
        securityLogger.record(eventName || 'auth.session.cookie_clear_failed', req, {
            id_login: req.tokenDecode ? req.tokenDecode.id_login : null,
            id_session_present: Boolean(req.tokenDecode && req.tokenDecode.id_session),
            reason: 'exception'
        });
    }
}

function buildTenantOperationalSessionData(tenantOperational) {
    const tenant = tenantOperational || {};

    return {
        allowed: tenant.allowed === true,
        code: tenant.code || null,
        reasonCode: tenant.reasonCode || null,
        tenantStatus: tenant.tenantStatus || tenant.status || null
    };
}

function buildBusinessSessionData(data, decoded) {
    const business = data && data.business ? data.business : {};

    return {
        id_business: business.id_business || decoded.id_business || null,
        name: business.name || decoded.business_name || null,
        slug: business.slug || decoded.business_slug || null,
        status: business.status || decoded.business_status || null,
        subscriptionStatus: business.subscription_status || decoded.business_subscription_status || null,
        registrationWelcomePending: business.registrationWelcomePending === true,
        registrationActivationConfirmed: business.registrationActivationConfirmed === true,
        plan: business.plan || decoded.business_plan || null
    };
}

function buildD2SessionResponseData(data) {
    const decoded = decodeAccessToken(data ? data.token : null);
    const accessExpiresAt = decoded.exp
        ? new Date(decoded.exp * 1000).toISOString()
        : null;

    return {
        authenticated: true,
        user: {
            id_login: decoded.id_login || null,
            name: decoded.name || null,
            email: decoded.email || null
        },
        role: {
            code: decoded.rol || null,
            name: decoded.role_name || null
        },
        permissions: Array.isArray(data && data.permisos) ? data.permisos : [],
        business: buildBusinessSessionData(data, decoded),
        tenantOperational: buildTenantOperationalSessionData(data ? data.tenantOperational : null),
        accessExpiresAt,
        sessionState: 'active'
    };
}

class AuthController extends httpResponseHelper{
  csrf = async(req, res, next) =>{
    try {
        const issued = CsrfTokenService.issueToken(req);
        const cookieName = CsrfTokenService.csrfCookieName();

        res.cookie(cookieName, issued.token, CsrfTokenService.csrfCookieOptions());

        const response = responseData.success({
            csrfToken: issued.token,
            headerName: SecurityConfig.getCsrfHeaderName(),
            expiresAt: issued.expiresAt,
            contextType: issued.contextType
        }, MESSAGES.DATA_GET_SUCCESSFULLY);

        securityLogger.record('auth.csrf.issued', req, {
            context_type: issued.contextType,
            expires_at: issued.expiresAt
        });

        res.status(response.status).send(response);
    } catch (error) {
        securityLogger.record('auth.csrf.failed', req, {
            reason: 'issue_exception'
        });
        const response = this.HttpError(error.status, error.message);
        res.status(response.status).send(response);
    }
  }
/**
 * Función que permite obtener la lista de roles del sistema
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  login = async(req, res, next) =>{
    let body = req.body;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
       const d2CookieAuth = hasD2BrowserCookieAuth();
       const loginBody = d2CookieAuth ? { ...body, refresh: true } : body;
       response  = await AuthDao.login(loginBody, {
        ip: req.ip,
        userAgent: req.get ? req.get('user-agent') : null
       });
      //  setHeaders(response, res);

      if (isSuccess(response)) {
        if (d2CookieAuth) {
            response = applyD2LoginCookies(response, res);
        }
        if (req.authRateLimit) {
            req.authRateLimit.recordSuccess();
        }
        securityLogger.record('auth.login.success', req, {
            phone: req.authIdentity ? req.authIdentity.phone : null,
            id_login: response.data && response.data.user ? response.data.user.id_login : null
        });
      } else {
        let failureLimit = { limited: false };
        if (req.authRateLimit) {
            failureLimit = req.authRateLimit.recordFailure();
        }
        securityLogger.record('auth.login.failed', req, {
            phone: req.authIdentity ? req.authIdentity.phone : null,
            reason: 'invalid_credentials_or_auth_block'
        });

        if (failureLimit && failureLimit.limited) {
            response = rateLimited(failureLimit.retryAfterSeconds);
        } else if (Number(response.status) !== 403) {
            response = genericNotSuccess(GENERIC_LOGIN_ERROR);
        }
      }
    } catch (error) {
        let failureLimit = { limited: false };
        if (req.authRateLimit) {
            failureLimit = req.authRateLimit.recordFailure();
        }
        securityLogger.record('auth.login.failed', req, {
            phone: req.authIdentity ? req.authIdentity.phone : null,
            reason: 'exception'
        });
        response = failureLimit && failureLimit.limited
            ? rateLimited(failureLimit.retryAfterSeconds)
            : genericNotSuccess(GENERIC_LOGIN_ERROR);
    }
    res.status(response.status).send(response);
  } 


  /**
   * Función que permite obtener la lista de roles del sistema
   * @param {any} req request
   * @param {any} res response
   * @param {any} next next
   * @author Cristian Eduardo Méndez Iglesias
   * @author Marco Antonio Saraos Hernandez
   * @author Humberto Trinidad Domínguez
   */
  session = async(req, res, next) =>{
    let response = responseData.success({ authenticated: false }, MESSAGES.DATA_GET_SUCCESSFULLY);
    const d2CookieAuth = hasD2BrowserCookieAuth();

    if (req.authTokenInvalid) {
        const accessExpired = ['TokenExpiredError', 'missing_access_with_refresh'].includes(req.authTokenError);
        const code = accessExpired ? 'AUTH_ACCESS_EXPIRED'
            : req.authTokenError === 'inactive_session' ? 'AUTH_SESSION_INVALID' : 'AUTH_ACCESS_INVALID';
        if (d2CookieAuth && !accessExpired) {
            clearD2AuthCookiesBestEffort(req, res, 'auth.session.cookie_clear_failed');
        }
        securityLogger.record('auth.session.failed', req, {
            reason: accessExpired ? 'access_expired' : 'invalid_token',
            token_source: req.authTokenSource || null
        });
        response = responseData.unauthorized(MESSAGES.UNAUTHORIZED, { code });
        res.status(response.status).send(response);
        return;
    }

    if (!req.tokenDecode) {
        securityLogger.record('auth.session.anonymous', req, {
            token_present: req.authTokenPresent === true
        });
        res.status(response.status).send(response);
        return;
    }

    if (!req.tokenDecode.id_login || !req.tokenDecode.id_session) {
        if (d2CookieAuth) {
            clearD2AuthCookiesBestEffort(req, res, 'auth.session.cookie_clear_failed');
        }
        securityLogger.record('auth.session.failed', req, {
            id_login: req.tokenDecode.id_login || null,
            id_session_present: Boolean(req.tokenDecode.id_session),
            reason: 'missing_session_claims'
        });
        response = responseData.unauthorized(MESSAGES.UNAUTHORIZED, { code: 'AUTH_SESSION_INVALID' });
        res.status(response.status).send(response);
        return;
    }

    try {
        response = await AuthDao.session({
            id_login: req.tokenDecode.id_login,
            id_session: req.tokenDecode.id_session
        });

        if (!isSuccess(response)) {
            if (d2CookieAuth) {
                clearD2AuthCookiesBestEffort(req, res, 'auth.session.cookie_clear_failed');
            }
            securityLogger.record('auth.session.failed', req, {
                id_login: req.tokenDecode.id_login,
                id_session_present: true,
                reason: 'inactive_or_revoked_session'
            });
            response = responseData.unauthorized(MESSAGES.UNAUTHORIZED, { code: 'AUTH_SESSION_INVALID' });
        } else {
            const sessionData = buildD2SessionResponseData(response.data);
            if (req.tokenDecode.auth_method === 'hemia_sso') {
                sessionData.accessExpiresAt = new Date(req.tokenDecode.exp * 1000).toISOString();
            }
            response = responseData.success(sessionData, MESSAGES.DATA_GET_SUCCESSFULLY);
            securityLogger.record('auth.session.success', req, {
                id_login: req.tokenDecode.id_login,
                id_session_present: true
            });
        }
    } catch (error) {
        securityLogger.record('auth.session.failed', req, {
            id_login: req.tokenDecode ? req.tokenDecode.id_login : null,
            id_session_present: Boolean(req.tokenDecode && req.tokenDecode.id_session),
            reason: 'exception'
        });
        response = this.HttpError(error.status, error.message);
    }

    res.status(response.status).send(response);
  }


  refreshToken = async(req, res, next) =>{
    let body = req.body;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    const d2CookieAuth = hasD2BrowserCookieAuth();
    let refreshBody = body;
    let hasRefreshTokenForLog = Boolean(body && (body.id_refresh_token || body.refresh_token));
    try {
        if (d2CookieAuth) {
            const d2RefreshRequest = getD2RefreshRequestBody(req);
            refreshBody = d2RefreshRequest.body;
            hasRefreshTokenForLog = d2RefreshRequest.hasRefreshToken;
        }
        response = await AuthDao.refreshToken(refreshBody, {
            ip: req.ip,
            userAgent: req.get ? req.get('user-agent') : null
        });
        const rotatedByDao = Boolean(response && response.data && response.data.refresh_token);
        const securityEvent = response ? response.securityEvent : null;
        if (response && response.securityEvent) {
            delete response.securityEvent;
        }
        if (securityEvent && securityEvent.event) {
            securityLogger.record(securityEvent.event, req, securityEvent);
        }
        if (!isSuccess(response)) {
            securityLogger.record('auth.refresh.failed', req, {
                reason: 'invalid_or_expired_refresh_token',
                has_refresh_token: hasRefreshTokenForLog
            });
            response = responseData.unauthorized(GENERIC_REFRESH_ERROR);
        } else {
            if (d2CookieAuth) {
                response = applyD2RefreshCookies(response, res);
            }
            if (!securityEvent || securityEvent.event !== 'auth.refresh.success') {
                securityLogger.record('auth.refresh.success', req, {
                    rotated: rotatedByDao
                });
            }
        }
    } catch (error) {
        securityLogger.record('auth.refresh.failed', req, {
            reason: 'exception',
            has_refresh_token: hasRefreshTokenForLog
        });
        response = responseData.unauthorized(GENERIC_REFRESH_ERROR);
    }
    res.status(response.status).send(response);
  }


  /**
 * Función que permite obtener la lista de roles del sistema
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  close = async(req, res, next) =>{
    // let body = req.body;
    let _body = req.body;
    _body.id_login = req.tokenDecode.id_login;
    _body.id_session = req.tokenDecode.id_session;
    let response = this.HttpNotAutorized(HttpStatus.UNAUTHORIZED, MESSAGES.NOT_CONTENT);
    const d2CookieAuth = hasD2BrowserCookieAuth();
    try {
         response = await AuthDao.close(_body);
         securityLogger.record('auth.logout', req, {
            id_login: req.tokenDecode ? req.tokenDecode.id_login : null,
            id_session: req.tokenDecode ? req.tokenDecode.id_session : null,
            success: isSuccess(response)
         });
    } catch (error) {
        response = this.HttpError(error.status, error.message);
        securityLogger.record('auth.logout', req, {
            id_login: req.tokenDecode ? req.tokenDecode.id_login : null,
            id_session: req.tokenDecode ? req.tokenDecode.id_session : null,
            success: false
        });
    }
    if (d2CookieAuth) {
        try {
            clearD2AuthCookies(res);
        } catch (error) {
            securityLogger.record('auth.logout.cookie_clear_failed', req, {
                id_login: req.tokenDecode ? req.tokenDecode.id_login : null,
                id_session_present: Boolean(req.tokenDecode && req.tokenDecode.id_session),
                reason: 'exception'
            });
        }
    }
    res.status(response.status).send(response);
  } 

   /**
 * Función que permite obtener la lista de roles del sistema
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
   forze_close = async(req, res, next) =>{
    // let body = req.body;
    let _body = req.body;
    _body.id_login = req.tokenDecode.id_login;
    let response = this.HttpNotAutorized(HttpStatus.UNAUTHORIZED, MESSAGES.NOT_CONTENT);
    try {
         response = await AuthDao.forze_close(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 


  /**
 * Función que permite obtener la lista de roles del sistema
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  sendOtpRecoverPassword = async(req, res, next) =>{
    let phone = req.body.phone;
    let response = responseData.success({ sent: true }, GENERIC_RECOVERY_RESPONSE);
    try {
        const daoResponse = await AuthDao.sendOtpRecoverPassword(phone, {
            ip: req.ip,
            userAgent: req.get ? req.get('user-agent') : null
        });
        recordSecurityEvent(req, daoResponse ? daoResponse.securityEvent : null, 'auth.password_reset.requested', {
            accepted: isSuccess(daoResponse)
        });
    } catch (error) {
        recordSecurityEvent(req, null, 'auth.password_reset.requested', {
            accepted: false
        });
    }
    res.status(response.status).send(response);
  }

    /**
 * Función que permite validar un otp
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
    validateOtp = async(req, res, next) =>{
      let body = req.body;
      let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
      try {
          response = await AuthDao.validateOtp(body);
          const securityEvent = response ? response.securityEvent : null;
          if (response && response.securityEvent) {
              delete response.securityEvent;
          }
          if (isSuccess(response)) {
              recordSecurityEvent(req, securityEvent, 'auth.password_reset.code_verified');
          } else {
              recordSecurityEvent(req, securityEvent, 'auth.password_reset.code_failed', {
                  reason: securityEvent && securityEvent.reason ? securityEvent.reason : 'invalid_or_expired_code'
              });
              response = genericNotSuccess(GENERIC_OTP_ERROR);
          }
      } catch (error) {
          recordSecurityEvent(req, null, 'auth.password_reset.code_failed', {
              reason: 'exception'
          });
          response = genericNotSuccess(GENERIC_OTP_ERROR);
      }
      res.status(response.status).send(response);
    }

    /**
     * Función que permite reestablecer la contraseña de un usuario
     * @param {any} req request
     * @param {any} res response
     * @param {any} next next
     * @author Cristian Eduardo Méndez Iglesias
     * @author Marco Antonio Saraos Hernandez
     * @author Humberto Trinidad Domínguez
     */
    ressetPassword = async(req, res, next) =>{
      let body = req.body;
      let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
      try {
          response = await AuthDao.reseetPassword(body);
          const securityEvent = response ? response.securityEvent : null;
          if (response && response.securityEvent) {
              delete response.securityEvent;
          }
          if (isSuccess(response)) {
              recordSecurityEvent(req, securityEvent, 'auth.password_reset.success', {
                  sessions_invalidated: response.data && response.data.sessions_invalidated ? true : false
              });
          } else {
              recordSecurityEvent(req, securityEvent, 'auth.password_reset.failed', {
                  reason: securityEvent && securityEvent.reason ? securityEvent.reason : 'invalid_or_expired_code'
              });
              response = genericNotSuccess(GENERIC_RESET_ERROR);
          }
      } catch (error) {
          recordSecurityEvent(req, null, 'auth.password_reset.failed', {
              reason: 'exception'
          });
          response = genericNotSuccess(GENERIC_RESET_ERROR);
      }
      res.status(response.status).send(response);
  }

    requestPasswordChangeCode = async(req, res) => {
        let response;
        try {
            response = await AuthDao.requestPasswordChangeCode(req.tokenDecode.id_login, req.body, {
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : null
            });
            const securityEvent = response ? response.securityEvent : null;
            if (response && response.securityEvent) delete response.securityEvent;
            recordSecurityEvent(req, securityEvent, 'auth.password_change.code_requested', {
                accepted: isSuccess(response)
            });
        } catch {
            recordSecurityEvent(req, null, 'auth.password_change.code_requested', {
                accepted: false,
                reason: 'exception'
            });
            response = responseData.error('No se pudo iniciar el cambio de contrasena.');
        }
        res.status(response.status).send(response);
    }

    confirmPasswordChange = async(req, res) => {
        let response;
        try {
            response = await AuthDao.confirmPasswordChange(
                req.tokenDecode.id_login,
                req.tokenDecode.id_session,
                req.body.code
            );
            const securityEvent = response ? response.securityEvent : null;
            if (response && response.securityEvent) delete response.securityEvent;
            recordSecurityEvent(req, securityEvent, 'auth.password_change.code_failed', {
                accepted: isSuccess(response)
            });
        } catch {
            recordSecurityEvent(req, null, 'auth.password_change.failed', {
                reason: 'exception'
            });
            response = responseData.error('No se pudo confirmar el cambio de contrasena.');
        }
        res.status(response.status).send(response);
    }

}

module.exports = new AuthController;
// Shared D2 issuance for self-registration; never serialize legacy token data.
module.exports.applyD2LoginCookies = applyD2LoginCookies;

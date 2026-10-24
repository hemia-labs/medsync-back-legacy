
const responseData = require('../util/responsedata');
const jwt = require('jsonwebtoken');
const configjwt = require('../config/jwt');
const AuthCookieConfig = require('../config/authCookie.config');
const { getHeaders } = require('../util/headers');
const activePrincipal = require('./activePrincipal');
const { enforcePendingActivation } = require('./pendingActivation');

//Colocar en false para productivo
const Istest = false;
var Auth = require('express').Router();

/**
 * 
 * @param {*} payload 
 * @param {*} applyVigence 
 * @returns 
 */
  function GetAccessToken(payload, omitVigence = false)
  {
        if (payload == undefined || payload == null) payload = {};

        let token = null;
        payload.check = true;
        
        if(omitVigence) token = jwt.sign(payload, configjwt.key, { algorithm: 'HS256' });
        else token = jwt.sign(payload, configjwt.key, { ...configjwt.expiresIn, algorithm: 'HS256' });
        return {
          token: token
        };
  }

  function isD2CookieAuthEnabled() {
        return AuthCookieConfig.getAuthCookieConfig().isCookieAuthEnabled;
  }

  function getAuthorizationToken(req) {
        const authorization = getHeaders(req).authorization;
        return authorization && authorization.replace(/^Bearer\s+/i, '');
  }

  function getAccessCookieToken(req) {
        const config = AuthCookieConfig.assertAuthCookieConfig();
        const names = AuthCookieConfig.getCookieNames(config);
        return req && req.cookies ? req.cookies[names.access] : null;
  }

  function getAuthToken(req) {
        return isD2CookieAuthEnabled() ? getAccessCookieToken(req) : getAuthorizationToken(req);
  }

  function hasRefreshCookie(req) {
        if (!isD2CookieAuthEnabled()) return false;
        const names = AuthCookieConfig.getCookieNames(AuthCookieConfig.assertAuthCookieConfig());
        return Boolean(req && req.cookies && req.cookies[names.refresh]);
  }

/**
 * Verifica el token
 */
  Auth.use(async (req, res, next) => {
      const token = getAuthToken(req);
      let response = responseData.unauthorized('Token Invalido.', { code: 'AUTH_ACCESS_INVALID' });

      if (Istest)
      {
        next();
        return true;
      }

      if (token) {
        let decoded;
        try { decoded = jwt.verify(token, configjwt.key, { algorithms: ['HS256'] }); }
        catch (error) {
          if (error.name === 'TokenExpiredError') {
            response = responseData.unauthorized('El acceso ha vencido.', { code: 'AUTH_ACCESS_EXPIRED' });
          }
          res.status(response.status).send(response); return;
        }
        try {
          const principal = await activePrincipal(decoded);
          if (!principal) {
            response = responseData.unauthorized('La sesion ya no esta activa.', { code: 'AUTH_SESSION_INVALID' });
            res.status(response.status).send(response); return;
          }
          req.tokenDecode = principal;
          if (enforcePendingActivation(req, res)) return;
          next();
        } catch (error) { next(error); }
      } else {
        // Presence only permits the client to attempt the refresh endpoint. It
        // never authorizes this request or supplies identity from an old token.
        if (hasRefreshCookie(req)) {
          response = responseData.unauthorized('El acceso ha vencido.', { code: 'AUTH_ACCESS_EXPIRED' });
        }
        res.status(response.status).send(response);
      }
  });

  var OptionalAuth = require('express').Router();
  OptionalAuth.use(async (req, res, next) => {
      const token = getAuthToken(req);
      req.authTokenPresent = Boolean(token);
      req.authTokenInvalid = false;
      req.authTokenSource = isD2CookieAuthEnabled() ? 'cookie' : 'authorization';

      if (!token) {
        if (hasRefreshCookie(req)) {
          req.authTokenInvalid = true;
          req.authTokenError = 'missing_access_with_refresh';
        }
        next();
        return;
      }

      let decoded;
      try { decoded = jwt.verify(token, configjwt.key, { algorithms: ['HS256'] }); }
      catch (error) {
        req.authTokenInvalid = true;
        req.authTokenError = error.name || 'invalid_token';
        next(); return;
      }
      try {
        const principal = await activePrincipal(decoded);
        if (principal) {
          req.tokenDecode = principal;
          if (enforcePendingActivation(req, res)) return;
        }
        else {
          req.authTokenInvalid = true;
          req.authTokenError = 'inactive_session';
        }
        next();
      } catch (error) { next(error); }
  });


  module.exports = {
    GetAccessToken,
    Auth : Auth,
    OptionalAuth: OptionalAuth
  };


const responseData = require('../util/responsedata');
const jwt = require('jsonwebtoken');
const configjwt = require('../config/jwt');
const AuthCookieConfig = require('../config/authCookie.config');
const { getHeaders } = require('../util/headers');

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

/**
 * Verifica el token
 */
  Auth.use((req, res, next) => {
      const token = getAuthToken(req);
      let response = responseData.unauthorized("Token Invalido.");;

      if (Istest)
      {
        next();
        return true;
      }

      if (token) {
        jwt.verify(token, configjwt.key, { algorithms: ['HS256'] }, (err, decoded) => {
          if (err) {
            res.status(response.status).send(response);
          } else {
            req.tokenDecode = decoded;
            next();
          }
        });
      } else {
        res.status(response.status).send(response);
      }
  });

  var OptionalAuth = require('express').Router();
  OptionalAuth.use((req, res, next) => {
      const token = getAuthToken(req);
      req.authTokenPresent = Boolean(token);
      req.authTokenInvalid = false;
      req.authTokenSource = isD2CookieAuthEnabled() ? 'cookie' : 'authorization';

      if (!token) {
        next();
        return;
      }

      jwt.verify(token, configjwt.key, { algorithms: ['HS256'] }, (err, decoded) => {
        if (!err) {
          req.tokenDecode = decoded;
        } else {
          req.authTokenInvalid = true;
          req.authTokenError = err.name || 'invalid_token';
        }
        next();
      });
  });


  module.exports = {
    GetAccessToken,
    Auth : Auth,
    OptionalAuth: OptionalAuth
  };

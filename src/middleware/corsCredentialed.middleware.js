'use strict';

const SecurityConfig = require('../config/security');

function getHeader(res, name) {
  if (typeof res.getHeader === 'function') {
    return res.getHeader(name);
  }

  if (res.headers) {
    return res.headers[name] || res.headers[String(name).toLowerCase()];
  }

  return undefined;
}

function setHeader(res, name, value) {
  if (typeof res.header === 'function') {
    res.header(name, value);
    return;
  }

  if (typeof res.setHeader === 'function') {
    res.setHeader(name, value);
    return;
  }

  res.headers = res.headers || {};
  res.headers[name] = value;
}

function appendVaryOrigin(res) {
  const current = getHeader(res, 'Vary');
  const values = Array.isArray(current)
    ? current
    : String(current || '').split(',');
  const normalized = values
    .map((value) => String(value).trim())
    .filter(Boolean);

  if (!normalized.some((value) => value.toLowerCase() === 'origin')) {
    normalized.push('Origin');
  }

  setHeader(res, 'Vary', normalized.join(', '));
}

function resolveAllowedOrigin(requestOrigin, config) {
  if (!requestOrigin) {
    return null;
  }

  if (config.allowAnyOrigin && !config.credentials) {
    return '*';
  }

  return config.origins.includes(requestOrigin) ? requestOrigin : null;
}

function setCommonCorsHeaders(res, config) {
  const allowedMethods = config.allowedMethods.join(', ');

  setHeader(res, 'Access-Control-Allow-Headers', config.allowedHeaders.join(', '));
  setHeader(res, 'Access-Control-Allow-Methods', allowedMethods);
  setHeader(res, 'Allow', allowedMethods);

  if (Number.isInteger(config.maxAgeSeconds) && config.maxAgeSeconds > 0) {
    setHeader(res, 'Access-Control-Max-Age', String(config.maxAgeSeconds));
  }
}

function setAllowedOriginCorsHeaders(res, allowedOrigin, config) {
  setHeader(res, 'Access-Control-Allow-Origin', allowedOrigin);

  if (allowedOrigin !== '*') {
    appendVaryOrigin(res);
  }

  if (config.credentials) {
    setHeader(res, 'Access-Control-Allow-Credentials', 'true');
  }
}

function sendStatus(res, statusCode) {
  if (typeof res.sendStatus === 'function') {
    return res.sendStatus(statusCode);
  }

  if (typeof res.status === 'function') {
    res.status(statusCode);
  } else {
    res.statusCode = statusCode;
  }

  if (typeof res.send === 'function') {
    return res.send();
  }

  return undefined;
}

function corsCredentialedAllowlist(options = {}) {
  return function corsCredentialedAllowlistMiddleware(req, res, next) {
    const config = options.config || SecurityConfig.getCorsRuntimeConfig();
    const requestOrigin = req.headers ? req.headers.origin : null;
    const allowedOrigin = resolveAllowedOrigin(requestOrigin, config);

    setCommonCorsHeaders(res, config);

    if (allowedOrigin) {
      setAllowedOriginCorsHeaders(res, allowedOrigin, config);
    }

    if (req.method === 'OPTIONS') {
      if (requestOrigin && !allowedOrigin) {
        return sendStatus(res, 403);
      }

      return sendStatus(res, 204);
    }

    return next();
  };
}

module.exports = {
  appendVaryOrigin,
  corsCredentialedAllowlist,
  resolveAllowedOrigin
};

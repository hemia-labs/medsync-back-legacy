'use strict';

const { getRuntimeEnv, isProductionLike } = require('../config/runtimeEnvironment');

const DEFAULT_CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline' https:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  "media-src 'self' data: blob: https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'"
];

const DEFAULT_PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'fullscreen=(self)'
].join(', ');

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].indexOf(normalized) >= 0) {
    return true;
  }
  if (['false', '0', 'no', 'off'].indexOf(normalized) >= 0) {
    return false;
  }

  return fallback;
}

function isProductionLikeRuntime() {
  // Preserve HSTS in staging as well as the shared production decision.
  return isProductionLike() || ['staging', 'stage'].includes(getRuntimeEnv());
}

function isHttpsRequest(req) {
  return Boolean(req && (req.secure || req.protocol === 'https'));
}

function buildHstsValue(options) {
  const maxAge = options.hstsMaxAgeSeconds || process.env.SECURITY_HSTS_MAX_AGE_SECONDS || '31536000';
  const includeSubDomains = parseBoolean(process.env.SECURITY_HSTS_INCLUDE_SUBDOMAINS, true);
  const preload = parseBoolean(process.env.SECURITY_HSTS_PRELOAD, false);
  const parts = [`max-age=${maxAge}`];

  if (includeSubDomains) {
    parts.push('includeSubDomains');
  }

  if (preload) {
    parts.push('preload');
  }

  return parts.join('; ');
}

function buildCspValue(options) {
  const configured = options.csp || process.env.SECURITY_CSP;
  if (configured) {
    return configured;
  }

  return DEFAULT_CSP_DIRECTIVES.join('; ');
}

function securityHeaders(options) {
  const opts = options || {};

  return function securityHeadersMiddleware(req, res, next) {
    const enabled = parseBoolean(process.env.SECURITY_HEADERS_ENABLED, true);
    if (!enabled) {
      return next();
    }

    const cspReportOnly = parseBoolean(process.env.SECURITY_CSP_REPORT_ONLY, opts.cspReportOnly !== false);
    const cspHeaderName = cspReportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
    const frameOptions = opts.frameOptions || process.env.SECURITY_FRAME_OPTIONS || 'SAMEORIGIN';
    const permissionsPolicy = opts.permissionsPolicy || process.env.SECURITY_PERMISSIONS_POLICY || DEFAULT_PERMISSIONS_POLICY;

    res.setHeader(cspHeaderName, buildCspValue(opts));
    res.setHeader('X-Frame-Options', frameOptions);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', process.env.SECURITY_REFERRER_POLICY || 'no-referrer');
    res.setHeader('Permissions-Policy', permissionsPolicy);

    if (isProductionLikeRuntime() && isHttpsRequest(req)) {
      res.setHeader('Strict-Transport-Security', buildHstsValue(opts));
    }

    return next();
  };
}

module.exports = {
  securityHeaders,
  buildCspValue,
  isProductionLikeRuntime,
  isHttpsRequest
};

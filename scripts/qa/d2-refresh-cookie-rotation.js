'use strict';

require('../../src/config/env');

const AuthController = require('../../src/controller/mysql/auth.controller');
const AuthDao = require('../../src/Dao/mysql/auth.dao');
const Token = require('../../src/auth/authenticate');
const responseData = require('../../src/util/responsedata');
const AuthCookieConfig = require('../../src/config/authCookie.config');

const ENV_KEYS = [
  'AUTH_COOKIE_MODE',
  'BROWSER_AUTH_TRANSPORT',
  'AUTH_COOKIE_MAX_AGE_MODE',
  'AUTH_COOKIE_ACCESS_NAME',
  'AUTH_COOKIE_REFRESH_NAME',
  'AUTH_CSRF_COOKIE_NAME',
  'AUTH_COOKIE_SECURE',
  'AUTH_COOKIE_SAMESITE',
  'AUTH_COOKIE_DOMAIN',
  'AUTH_COOKIE_PATH',
  'CSRF_ENABLED',
  'CORS_CREDENTIALS',
  'CORS_ALLOWED_ORIGINS',
  'CORS_ORIGIN',
  'NODE_ENV',
  'APP_ENV',
  'ENVIRONMENT'
];

const COOKIE_REFRESH_TOKEN = 'v2.22222222-2222-4222-8222-222222222222.qa_cookie_input_not_printed';
const BODY_REFRESH_TOKEN = 'v2.33333333-3333-4333-8333-333333333333.qa_body_input_not_printed';
const ROTATED_REFRESH_TOKEN = 'v2.44444444-4444-4444-8444-444444444444.qa_rotated_output_not_printed';

function snapshotEnv() {
  return ENV_KEYS.reduce((snapshot, key) => {
    snapshot[key] = process.env[key];
    return snapshot;
  }, {});
}

function restoreEnv(snapshot) {
  ENV_KEYS.forEach((key) => {
    if (snapshot[key] === undefined) {
      delete process.env[key];
      return;
    }

    process.env[key] = snapshot[key];
  });
}

function setEnv(overrides) {
  ENV_KEYS.forEach((key) => {
    delete process.env[key];
  });

  Object.keys(overrides || {}).forEach((key) => {
    process.env[key] = overrides[key];
  });
}

function baseD2Env(overrides) {
  return Object.assign({
    NODE_ENV: 'development',
    AUTH_COOKIE_MODE: 'd2',
    BROWSER_AUTH_TRANSPORT: 'cookie',
    AUTH_COOKIE_ACCESS_NAME: '__Host-medsync_at',
    AUTH_COOKIE_REFRESH_NAME: '__Host-medsync_rt',
    AUTH_CSRF_COOKIE_NAME: '__Host-medsync_csrf',
    AUTH_COOKIE_SECURE: 'true',
    AUTH_COOKIE_SAMESITE: 'Lax',
    AUTH_COOKIE_DOMAIN: '',
    CSRF_ENABLED: 'true',
    CORS_CREDENTIALS: 'true',
    CORS_ALLOWED_ORIGINS: 'https://app.example.test'
  }, overrides || {});
}

function fakeAccessToken() {
  return Token.GetAccessToken({
    email: 'qa.d2.refresh@example.test',
    name: 'QA D2 Refresh User',
    telephone: '9993000333',
    id_login: 'QA_D2_REFRESH_USER',
    id_rol: 'QA_D2_ROLE',
    rol: 'admin',
    id_business: 'QA_D2_BUSINESS',
    id_session: 'QA_D2_SESSION',
    business_name: 'QA D2 Business',
    business_slug: 'qa-d2-business',
    business_status: 'active'
  }).token;
}

function fakeRefreshResponse() {
  const response = responseData.success({
    token: fakeAccessToken(),
    refresh_token: ROTATED_REFRESH_TOKEN,
    permisos: ['qa.d2.refresh.read'],
    tenantOperational: {
      allowed: true,
      code: null,
      reasonCode: null,
      tenantStatus: null,
      status: null
    },
    tenantOperationalMessage: null
  }, 'QA mock refresh OK');

  response.securityEvent = {
    event: 'auth.refresh.success',
    token_fingerprint: 'qa-safe-fingerprint',
    rotated: true
  };

  return response;
}

function createReq(options) {
  return {
    body: options.body || {},
    cookies: options.cookies || {},
    ip: '127.0.0.1',
    method: 'POST',
    originalUrl: '/api/auth/refreshToken',
    get() {
      return 'QA_D2_REFRESH_COOKIE_ROTATION';
    }
  };
}

function safeCookie(cookie) {
  const options = cookie.options || {};

  return {
    name: cookie.name,
    hasValue: Boolean(cookie.value),
    httpOnly: options.httpOnly === true,
    secure: options.secure === true,
    sameSite: options.sameSite || null,
    path: options.path || null,
    domainConfigured: Boolean(options.domain),
    maxAgeConfigured: Object.prototype.hasOwnProperty.call(options, 'maxAge'),
    expiresConfigured: Object.prototype.hasOwnProperty.call(options, 'expires')
  };
}

function createRes() {
  return {
    statusCode: null,
    payload: null,
    cookies: [],
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    }
  };
}

function containsForbiddenKeys(value) {
  const forbidden = ['token', 'refresh_token', 'id_refresh_token', 'access_token', 'id_session', 'token_hash', 'token_fingerprint'];

  if (!value || typeof value !== 'object') {
    return false;
  }

  return Object.keys(value).some((key) => {
    if (forbidden.includes(String(key).toLowerCase())) {
      return true;
    }

    return containsForbiddenKeys(value[key]);
  });
}

async function withMockedRefresh(env, reqOptions) {
  const envSnapshot = snapshotEnv();
  const originalRefreshToken = AuthDao.refreshToken;
  const originalInfo = console.info;
  const res = createRes();
  const observed = {
    receivedToken: false,
    usedCookieToken: false,
    usedBodyToken: false
  };

  try {
    setEnv(env);
    console.info = function noop() {};
    AuthDao.refreshToken = async (daoBody) => {
      const value = daoBody ? daoBody.id_refresh_token || daoBody.refresh_token : null;
      observed.receivedToken = Boolean(value);
      observed.usedCookieToken = value === COOKIE_REFRESH_TOKEN;
      observed.usedBodyToken = value === BODY_REFRESH_TOKEN;

      if (!value) {
        return responseData.unauthorized('QA mock refresh missing token');
      }

      return fakeRefreshResponse();
    };

    await AuthController.refreshToken(createReq(reqOptions), res, () => {});

    return {
      status: res.statusCode,
      cookieAuthEnabled: AuthCookieConfig.getAuthCookieConfig().isCookieAuthEnabled,
      cookies: res.cookies.map(safeCookie),
      observed,
      hasForbiddenResponseKeys: containsForbiddenKeys(res.payload),
      payloadShape: {
        hasData: Boolean(res.payload && res.payload.data),
        authenticated: Boolean(res.payload && res.payload.data && res.payload.data.authenticated),
        hasLegacyToken: Boolean(res.payload && res.payload.data && res.payload.data.token),
        hasLegacyRefreshToken: Boolean(res.payload && res.payload.data && res.payload.data.refresh_token)
      }
    };
  } finally {
    AuthDao.refreshToken = originalRefreshToken;
    console.info = originalInfo;
    restoreEnv(envSnapshot);
  }
}

function pass(name, detail) {
  return { name, ok: true, detail: detail || null };
}

function fail(name, detail) {
  return { name, ok: false, detail: detail || null };
}

function cookieByName(result, name) {
  return result.cookies.find((cookie) => cookie.name === name) || null;
}

async function validate() {
  const checks = [];
  const legacy = await withMockedRefresh({
    AUTH_COOKIE_MODE: 'legacy',
    BROWSER_AUTH_TRANSPORT: 'authorization'
  }, {
    body: { id_refresh_token: BODY_REFRESH_TOKEN },
    cookies: { '__Host-medsync_rt': COOKIE_REFRESH_TOKEN }
  });

  checks.push(
    legacy.status === 200 &&
    legacy.cookieAuthEnabled === false &&
    legacy.cookies.length === 0 &&
    legacy.observed.usedBodyToken &&
    legacy.payloadShape.hasLegacyToken &&
    legacy.payloadShape.hasLegacyRefreshToken
      ? pass('legacy refresh keeps body token contract and sets no cookies', {
        cookieCount: legacy.cookies.length,
        usedBodyToken: legacy.observed.usedBodyToken,
        hasLegacyToken: legacy.payloadShape.hasLegacyToken,
        hasLegacyRefreshToken: legacy.payloadShape.hasLegacyRefreshToken
      })
      : fail('legacy refresh keeps body token contract and sets no cookies', legacy)
  );

  const partial = await withMockedRefresh({
    AUTH_COOKIE_MODE: 'd2',
    BROWSER_AUTH_TRANSPORT: 'authorization'
  }, {
    body: { id_refresh_token: BODY_REFRESH_TOKEN },
    cookies: { '__Host-medsync_rt': COOKIE_REFRESH_TOKEN }
  });

  checks.push(
    partial.status === 200 &&
    partial.cookieAuthEnabled === false &&
    partial.cookies.length === 0 &&
    partial.observed.usedBodyToken &&
    partial.payloadShape.hasLegacyToken
      ? pass('partial D2 flags do not enable refresh cookie mode', {
        cookieCount: partial.cookies.length,
        usedBodyToken: partial.observed.usedBodyToken
      })
      : fail('partial D2 flags do not enable refresh cookie mode', partial)
  );

  const d2 = await withMockedRefresh(baseD2Env(), {
    body: { id_refresh_token: BODY_REFRESH_TOKEN },
    cookies: { '__Host-medsync_rt': COOKIE_REFRESH_TOKEN }
  });
  const accessCookie = cookieByName(d2, '__Host-medsync_at');
  const refreshCookie = cookieByName(d2, '__Host-medsync_rt');

  checks.push(
    d2.status === 200 &&
    d2.cookieAuthEnabled === true &&
    d2.observed.usedCookieToken &&
    !d2.observed.usedBodyToken &&
    accessCookie &&
    refreshCookie &&
    accessCookie.httpOnly &&
    refreshCookie.httpOnly &&
    accessCookie.secure &&
    refreshCookie.secure &&
    accessCookie.path === '/' &&
    refreshCookie.path === '/' &&
    !accessCookie.maxAgeConfigured &&
    !refreshCookie.maxAgeConfigured &&
    !accessCookie.expiresConfigured &&
    !refreshCookie.expiresConfigured &&
    d2.payloadShape.authenticated &&
    !d2.hasForbiddenResponseKeys
      ? pass('d2 refresh reads cookie, rotates cookies and strips tokens from JSON', {
        cookies: d2.cookies,
        usedCookieToken: d2.observed.usedCookieToken,
        usedBodyToken: d2.observed.usedBodyToken,
        hasForbiddenResponseKeys: d2.hasForbiddenResponseKeys
      })
      : fail('d2 refresh reads cookie, rotates cookies and strips tokens from JSON', d2)
  );

  const d2MissingCookie = await withMockedRefresh(baseD2Env(), {
    body: { id_refresh_token: BODY_REFRESH_TOKEN },
    cookies: {}
  });

  checks.push(
    d2MissingCookie.status === 401 &&
    !d2MissingCookie.observed.usedBodyToken &&
    d2MissingCookie.cookies.length === 0
      ? pass('d2 refresh does not fall back to body when cookie is missing', {
        status: d2MissingCookie.status,
        usedBodyToken: d2MissingCookie.observed.usedBodyToken,
        cookieCount: d2MissingCookie.cookies.length
      })
      : fail('d2 refresh does not fall back to body when cookie is missing', d2MissingCookie)
  );

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}

function status() {
  return {
    ok: true,
    script: 'd2-refresh-cookie-rotation',
    dbAccess: false,
    fixtures: false,
    cleanupRequired: false,
    secretsPrinted: false,
    commands: ['status', 'validate']
  };
}

async function main() {
  const command = process.argv[2] || 'status';
  const commands = { status, validate };

  if (!commands[command]) {
    throw new Error(`Unsupported command: ${command}`);
  }

  const result = await commands[command]();

  if (result.ok === false) {
    console.log(JSON.stringify({ command, ok: false, result }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ command, ok: true, result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message
  }, null, 2));
  process.exitCode = 1;
});

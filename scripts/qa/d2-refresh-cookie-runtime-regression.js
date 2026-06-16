'use strict';

require('../../src/config/env');

const AuthController = require('../../src/controller/mysql/auth.controller');
const AuthDao = require('../../src/Dao/mysql/auth.dao');
const Token = require('../../src/auth/authenticate');
const responseData = require('../../src/util/responsedata');
const AuthCookieConfig = require('../../src/config/authCookie.config');
const CsrfTokenService = require('../../src/services/security/csrfToken.service');
const { csrfProtection } = require('../../src/middleware/csrf.middleware');
const { validateAuthPayload } = require('../../src/middleware/authPayloadValidation.middleware');

const ENV_KEYS = [
  'AUTH_COOKIE_MODE',
  'BROWSER_AUTH_TRANSPORT',
  'AUTH_COOKIE_MAX_AGE_MODE',
  'AUTH_COOKIE_ACCESS_NAME',
  'AUTH_COOKIE_REFRESH_NAME',
  'AUTH_CSRF_COOKIE_NAME',
  'CSRF_COOKIE_NAME',
  'AUTH_COOKIE_SECURE',
  'AUTH_COOKIE_SAMESITE',
  'AUTH_COOKIE_DOMAIN',
  'AUTH_COOKIE_PATH',
  'CSRF_ENABLED',
  'CSRF_TOKEN_SECRET',
  'CSRF_ALLOWED_ORIGINS',
  'CORS_CREDENTIALS',
  'CORS_ALLOWED_ORIGINS',
  'CORS_ORIGIN',
  'NODE_ENV',
  'APP_ENV',
  'ENVIRONMENT'
];

const OLD_REFRESH = 'v2.qa-old-refresh-cookie-value-not-printed';
const BODY_REFRESH = 'v2.qa-body-refresh-value-not-printed';
const ROTATED_REFRESH = 'v2.qa-rotated-refresh-cookie-value-not-printed';
const ROTATED_REFRESH_2 = 'v2.qa-rotated-refresh-cookie-value-2-not-printed';

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
    AUTH_COOKIE_MAX_AGE_MODE: 'session',
    AUTH_COOKIE_ACCESS_NAME: '__Host-medsync_at',
    AUTH_COOKIE_REFRESH_NAME: '__Host-medsync_rt',
    AUTH_CSRF_COOKIE_NAME: '__Host-medsync_csrf',
    AUTH_COOKIE_SECURE: 'true',
    AUTH_COOKIE_SAMESITE: 'Lax',
    AUTH_COOKIE_DOMAIN: '',
    AUTH_COOKIE_PATH: '/',
    CSRF_ENABLED: 'true',
    CSRF_TOKEN_SECRET: 'qa-d2-refresh-runtime-regression-csrf-secret-not-production',
    CSRF_ALLOWED_ORIGINS: 'https://app.example.test',
    CORS_CREDENTIALS: 'true',
    CORS_ALLOWED_ORIGINS: 'https://app.example.test'
  }, overrides || {});
}

function legacyEnv(overrides) {
  return Object.assign({
    NODE_ENV: 'development',
    AUTH_COOKIE_MODE: 'legacy',
    BROWSER_AUTH_TRANSPORT: 'authorization',
    CSRF_ENABLED: 'false'
  }, overrides || {});
}

function fakeAccessToken() {
  return Token.GetAccessToken({
    email: 'qa.d2.refresh.runtime@example.test',
    name: 'QA D2 Refresh Runtime User',
    telephone: '9993000444',
    id_login: 'QA_D2_REFRESH_RUNTIME_USER',
    id_rol: 'QA_D2_ROLE',
    rol: 'admin',
    id_business: 'QA_D2_BUSINESS',
    id_session: 'QA_D2_SESSION',
    business_name: 'QA D2 Business',
    business_slug: 'qa-d2-business',
    business_status: 'active'
  }).token;
}

function fakeSuccess(refreshToken) {
  const response = responseData.success({
    token: fakeAccessToken(),
    refresh_token: refreshToken,
    permisos: ['qa.d2.refresh.runtime'],
    tenantOperational: {
      allowed: true,
      code: null,
      reasonCode: null,
      tenantStatus: null,
      status: null
    },
    tenantOperationalMessage: null
  }, 'QA mock refresh runtime OK');

  response.securityEvent = {
    event: 'auth.refresh.success',
    token_fingerprint: 'qa-safe-fingerprint',
    rotated: true
  };

  return response;
}

function createReq(options) {
  const headers = Object.assign({}, options.headers || {});
  return {
    body: options.body || {},
    cookies: options.cookies || {},
    headers,
    ip: '127.0.0.1',
    method: 'POST',
    originalUrl: '/api/auth/refreshToken',
    url: '/api/auth/refreshToken',
    get(name) {
      return headers[String(name || '').toLowerCase()] || 'QA_D2_REFRESH_RUNTIME_REGRESSION';
    }
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

function safeCookie(cookie) {
  const options = cookie.options || {};
  return {
    name: cookie.name,
    hasValue: Boolean(cookie.value),
    valueChanged: Boolean(cookie.value && cookie.value !== OLD_REFRESH),
    httpOnly: options.httpOnly === true,
    secure: options.secure === true,
    sameSite: options.sameSite || null,
    path: options.path || null,
    domainConfigured: Boolean(options.domain),
    maxAgeConfigured: Object.prototype.hasOwnProperty.call(options, 'maxAge'),
    expiresConfigured: Object.prototype.hasOwnProperty.call(options, 'expires')
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

function issueCsrf(req) {
  const config = AuthCookieConfig.getAuthCookieConfig();
  const names = AuthCookieConfig.getCookieNames(config);
  const issued = CsrfTokenService.issueToken(req);
  req.cookies[names.csrf] = issued.token;
  req.headers['x-csrf-token'] = issued.token;
  req.headers.origin = 'https://app.example.test';
  return {
    tokenPresent: Boolean(issued.token),
    cookieName: names.csrf,
    tokenPrinted: false
  };
}

function cookieNames() {
  return AuthCookieConfig.getCookieNames(AuthCookieConfig.getAuthCookieConfig());
}

function runMiddleware(middleware, req, res) {
  return new Promise((resolve, reject) => {
    let nextCalled = false;
    try {
      middleware(req, res, (error) => {
        nextCalled = true;
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      });
    } catch (error) {
      reject(error);
      return;
    }

    if (!nextCalled && res.statusCode !== null) {
      resolve(false);
    }
  });
}

async function runRefreshRequest(options) {
  const req = createReq(options);
  const res = createRes();

  if (options.addCsrf !== false && process.env.CSRF_ENABLED === 'true') {
    issueCsrf(req);
  } else if (options.invalidCsrf) {
    issueCsrf(req);
    req.headers['x-csrf-token'] = 'invalid-csrf-token-not-printed';
  }

  const csrfOk = await runMiddleware(csrfProtection(), req, res);
  if (!csrfOk) {
    return summarize(res, { csrfStopped: true });
  }

  const validationOk = await runMiddleware(validateAuthPayload('refreshToken'), req, res);
  if (!validationOk) {
    return summarize(res, { validationStopped: true });
  }

  await AuthController.refreshToken(req, res, () => {});
  return summarize(res, {
    sanitizedBodyKeys: Object.keys(req.body || {}),
    cookieAuthEnabled: AuthCookieConfig.getAuthCookieConfig().isCookieAuthEnabled
  });
}

function summarize(res, extra) {
  const data = res.payload && Object.prototype.hasOwnProperty.call(res.payload, 'data')
    ? res.payload.data
    : null;

  return Object.assign({
    status: res.statusCode,
    cookies: res.cookies.map(safeCookie),
    hasForbiddenResponseKeys: containsForbiddenKeys(data),
    payloadShape: {
      hasData: Boolean(data),
      authenticated: Boolean(data && data.authenticated),
      hasLegacyToken: Boolean(data && data.token),
      hasLegacyRefreshToken: Boolean(data && data.refresh_token)
    }
  }, extra || {});
}

async function withMockedDao(env, runner) {
  const envSnapshot = snapshotEnv();
  const originalRefreshToken = AuthDao.refreshToken;
  const originalInfo = console.info;
  const state = {
    oldRefreshUsed: false,
    observed: []
  };

  try {
    setEnv(env);
    console.info = function noop() {};
    AuthDao.refreshToken = async (daoBody) => {
      const value = daoBody ? daoBody.id_refresh_token || daoBody.refresh_token : null;
      state.observed.push({
        receivedToken: Boolean(value),
        usedOldCookieToken: value === OLD_REFRESH,
        usedRotatedCookieToken: value === ROTATED_REFRESH,
        usedBodyToken: value === BODY_REFRESH
      });

      if (!value) {
        return responseData.unauthorized('QA mock refresh missing token');
      }

      if (value === OLD_REFRESH && !state.oldRefreshUsed) {
        state.oldRefreshUsed = true;
        return fakeSuccess(ROTATED_REFRESH);
      }

      if (value === OLD_REFRESH && state.oldRefreshUsed) {
        const response = responseData.unauthorized('QA mock refresh reuse detected');
        response.securityEvent = {
          event: 'auth.refresh.reuse_detected',
          token_fingerprint: 'qa-safe-reuse-fingerprint'
        };
        return response;
      }

      if (value === ROTATED_REFRESH || value === BODY_REFRESH) {
        return fakeSuccess(ROTATED_REFRESH_2);
      }

      return responseData.unauthorized('QA mock refresh invalid token');
    };

    return await runner(state);
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

function hasCookie(result, name) {
  return result.cookies.some((cookie) => cookie.name === name && cookie.hasValue);
}

async function validate() {
  const checks = [];

  const d2Results = await withMockedDao(baseD2Env(), async (state) => {
    const names = cookieNames();
    const emptyBody = await runRefreshRequest({
      body: {},
      cookies: { [names.refresh]: OLD_REFRESH }
    });
    const bodyOnly = await runRefreshRequest({
      body: { id_refresh_token: BODY_REFRESH },
      cookies: {}
    });
    const reuseOld = await runRefreshRequest({
      body: {},
      cookies: { [names.refresh]: OLD_REFRESH }
    });
    const noCookie = await runRefreshRequest({
      body: {},
      cookies: {}
    });
    const missingCsrf = await runRefreshRequest({
      addCsrf: false,
      body: {},
      cookies: { [names.refresh]: ROTATED_REFRESH }
    });
    const invalidCsrf = await runRefreshRequest({
      addCsrf: false,
      invalidCsrf: true,
      body: {},
      cookies: { [names.refresh]: ROTATED_REFRESH }
    });
    return { names, emptyBody, bodyOnly, reuseOld, noCookie, missingCsrf, invalidCsrf, observed: state.observed };
  });

  checks.push(
    d2Results.emptyBody.status === 200 &&
    d2Results.emptyBody.payloadShape.authenticated &&
    d2Results.emptyBody.sanitizedBodyKeys.length === 0
      ? pass('D2 refresh accepts empty body', {
        status: d2Results.emptyBody.status,
        sanitizedBodyKeys: d2Results.emptyBody.sanitizedBodyKeys
      })
      : fail('D2 refresh accepts empty body', d2Results.emptyBody)
  );

  checks.push(
    d2Results.observed[0] &&
    d2Results.observed[0].usedOldCookieToken &&
    !d2Results.observed[0].usedBodyToken
      ? pass('D2 refresh reads refresh token from cookie', d2Results.observed[0])
      : fail('D2 refresh reads refresh token from cookie', d2Results.observed[0])
  );

  checks.push(
    d2Results.bodyOnly.status === 401 &&
    d2Results.observed[1] &&
    !d2Results.observed[1].usedBodyToken
      ? pass('D2 refresh body token is not accepted as source without cookie', {
        status: d2Results.bodyOnly.status,
        observed: d2Results.observed[1]
      })
      : fail('D2 refresh body token is not accepted as source without cookie', {
        result: d2Results.bodyOnly,
        observed: d2Results.observed[1]
      })
  );

  checks.push(
    hasCookie(d2Results.emptyBody, d2Results.names.access) &&
    hasCookie(d2Results.emptyBody, d2Results.names.refresh) &&
    d2Results.emptyBody.cookies.every((cookie) => cookie.httpOnly || cookie.name === d2Results.names.csrf)
      ? pass('D2 refresh sets rotated auth cookies', {
        cookies: d2Results.emptyBody.cookies
      })
      : fail('D2 refresh sets rotated auth cookies', d2Results.emptyBody.cookies)
  );

  checks.push(
    d2Results.emptyBody.payloadShape.authenticated &&
    !d2Results.emptyBody.hasForbiddenResponseKeys
      ? pass('D2 refresh returns tokenless JSON', {
        authenticated: d2Results.emptyBody.payloadShape.authenticated,
        hasForbiddenResponseKeys: d2Results.emptyBody.hasForbiddenResponseKeys
      })
      : fail('D2 refresh returns tokenless JSON', d2Results.emptyBody)
  );

  checks.push(
    d2Results.reuseOld.status === 401 &&
    d2Results.reuseOld.cookies.length === 0
      ? pass('Old refresh cookie fails after rotation and emits no new cookies', {
        status: d2Results.reuseOld.status,
        cookieCount: d2Results.reuseOld.cookies.length
      })
      : fail('Old refresh cookie fails after rotation and emits no new cookies', d2Results.reuseOld)
  );

  checks.push(
    d2Results.noCookie.status === 401
      ? pass('D2 refresh without cookie fails', {
        status: d2Results.noCookie.status
      })
      : fail('D2 refresh without cookie fails', d2Results.noCookie)
  );

  checks.push(
    d2Results.missingCsrf.status === 403 &&
    d2Results.invalidCsrf.status === 403
      ? pass('D2 refresh requires valid CSRF', {
        missingStatus: d2Results.missingCsrf.status,
        invalidStatus: d2Results.invalidCsrf.status
      })
      : fail('D2 refresh requires valid CSRF', {
        missing: d2Results.missingCsrf,
        invalid: d2Results.invalidCsrf
      })
  );

  const legacyResults = await withMockedDao(legacyEnv(), async (state) => {
    const missingBody = await runRefreshRequest({
      body: {},
      cookies: {}
    });
    const validBody = await runRefreshRequest({
      body: { id_refresh_token: BODY_REFRESH },
      cookies: {}
    });
    return { missingBody, validBody, observed: state.observed };
  });

  checks.push(
    legacyResults.missingBody.status === 400 &&
    legacyResults.validBody.status === 200 &&
    legacyResults.validBody.cookies.length === 0 &&
    legacyResults.validBody.payloadShape.hasLegacyToken &&
    legacyResults.validBody.payloadShape.hasLegacyRefreshToken &&
    legacyResults.observed[0] &&
    legacyResults.observed[0].usedBodyToken
      ? pass('Legacy refresh keeps body validation and legacy JSON contract', {
        missingBodyStatus: legacyResults.missingBody.status,
        validBodyStatus: legacyResults.validBody.status,
        cookieCount: legacyResults.validBody.cookies.length,
        usedBodyToken: legacyResults.observed[0].usedBodyToken
      })
      : fail('Legacy refresh keeps body validation and legacy JSON contract', legacyResults)
  );

  return {
    ok: checks.every((check) => check.ok),
    mode: 'd2 refresh cookie runtime regression',
    dbAccess: false,
    fixtures: 'in-memory mock only',
    cleanupRequired: false,
    secretsPrinted: false,
    refreshTokensPrinted: false,
    cookiesPrinted: false,
    csrfTokensPrinted: false,
    checks
  };
}

function status() {
  return {
    ok: true,
    script: 'd2-refresh-cookie-runtime-regression',
    dbAccess: false,
    fixtures: 'in-memory mock only',
    cleanupRequired: false,
    commands: ['status', 'validate', 'full'],
    requiredRuntimeEnv: [
      'AUTH_COOKIE_MODE=d2',
      'BROWSER_AUTH_TRANSPORT=cookie',
      'CSRF_ENABLED=true'
    ],
    safeOutput: {
      passwordsPrinted: false,
      otpPrinted: false,
      accessTokensPrinted: false,
      refreshTokensPrinted: false,
      cookiesPrinted: false,
      csrfPrinted: false
    }
  };
}

async function full() {
  return {
    ok: true,
    steps: [
      { step: 'status', result: status() },
      { step: 'validate', result: await validate() }
    ]
  };
}

async function main() {
  const command = process.argv[2] || 'status';
  const commands = { status, validate, full };

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

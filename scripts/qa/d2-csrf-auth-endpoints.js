'use strict';

require('../../src/config/env');

const AuthController = require('../../src/controller/mysql/auth.controller');
const Token = require('../../src/auth/authenticate');
const AuthCookieConfig = require('../../src/config/authCookie.config');
const SecurityConfig = require('../../src/config/security');
const CsrfTokenService = require('../../src/services/security/csrfToken.service');
const { csrfProtection } = require('../../src/middleware/csrf.middleware');
const AuthRouter = require('../../src/routes/mysql/auth');

const QA_CSRF_SECRET = 'QA_D2_3A_CSRF_SECRET_0123456789_abcdefghijklmnopqrstuvwxyz';
const ALLOWED_ORIGIN = 'https://app.example.test';
const BLOCKED_ORIGIN = 'https://evil.example.test';
const USER_AGENT = 'QA_D2_3A_CSRF_AUTH_ENDPOINTS';
const INVALID_TOKEN = 'qa.invalid.csrf.not_printed';

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
  'CSRF_HEADER_NAME',
  'CSRF_TOKEN_TTL_SECONDS',
  'CSRF_ORIGIN_CHECK_ENABLED',
  'CSRF_ALLOWED_ORIGINS',
  'CORS_CREDENTIALS',
  'CORS_ALLOWED_ORIGINS',
  'CORS_ORIGIN',
  'NODE_ENV',
  'APP_ENV',
  'ENVIRONMENT',
  'REQUIRE_ACTIVE_SESSION'
];

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
  Object.keys(overrides || {}).forEach((key) => {
    process.env[key] = overrides[key];
  });
}

function d2Env(overrides) {
  return Object.assign({
    NODE_ENV: 'development',
    REQUIRE_ACTIVE_SESSION: 'true',
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
    CSRF_TOKEN_SECRET: QA_CSRF_SECRET,
    CSRF_HEADER_NAME: 'X-CSRF-Token',
    CSRF_TOKEN_TTL_SECONDS: '900',
    CSRF_ORIGIN_CHECK_ENABLED: 'true',
    CSRF_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    CORS_CREDENTIALS: 'true',
    CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN
  }, overrides || {});
}

function legacyEnv(overrides) {
  return Object.assign({
    NODE_ENV: 'development',
    REQUIRE_ACTIVE_SESSION: 'true',
    AUTH_COOKIE_MODE: 'legacy',
    BROWSER_AUTH_TRANSPORT: 'authorization',
    CSRF_ENABLED: 'false'
  }, overrides || {});
}

async function withEnv(env, fn) {
  const snapshot = snapshotEnv();
  const originalInfo = console.info;
  try {
    setEnv(env);
    console.info = function noop() {};
    return await fn();
  } finally {
    console.info = originalInfo;
    restoreEnv(snapshot);
  }
}

function createReq(options = {}) {
  const headers = Object.assign({}, options.headers || {});
  return {
    body: Object.assign({}, options.body || {}),
    headers,
    cookies: Object.assign({}, options.cookies || {}),
    tokenDecode: options.tokenDecode || null,
    ip: '127.0.0.1',
    method: options.method || 'GET',
    url: options.url || '/qa/d2/csrf',
    originalUrl: options.url || '/qa/d2/csrf',
    get(name) {
      const lower = String(name || '').toLowerCase();
      if (lower === 'user-agent') {
        return USER_AGENT;
      }
      const key = Object.keys(headers).find((item) => String(item).toLowerCase() === lower);
      return key ? headers[key] : null;
    }
  };
}

function createRes(done) {
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
      if (done) done();
      return this;
    }
  };
}

function runCsrfEndpoint(reqOptions = {}) {
  return new Promise((resolve) => {
    const req = createReq(Object.assign({
      method: 'GET',
      url: '/api/auth/csrf'
    }, reqOptions));
    const res = createRes(finish);
    const result = { status: null, payload: null, cookies: [] };
    let finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      result.status = res.statusCode;
      result.payload = res.payload;
      result.cookies = res.cookies;
      resolve(result);
    }

    Token.OptionalAuth.handle(req, res, (error) => {
      if (error) {
        finish();
        return;
      }
      AuthController.csrf(req, res, () => finish());
    });
  });
}

function runCsrfMiddleware(reqOptions = {}) {
  const req = createReq(reqOptions);
  const res = createRes();
  const middleware = csrfProtection();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  return {
    status: res.statusCode || (nextCalled ? 200 : null),
    payload: res.payload,
    nextCalled,
    csrfContext: req.csrf ? req.csrf.contextType : null
  };
}

function cookieNames() {
  return AuthCookieConfig.getCookieNames(AuthCookieConfig.getAuthCookieConfig());
}

function cookieValue(result, name) {
  const cookie = result.cookies.find((item) => item.name === name);
  return cookie ? cookie.value : null;
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
    maxAgeConfigured: options.maxAge !== undefined,
    expiresConfigured: options.expires !== undefined
  };
}

function endpointDetail(result, names) {
  const data = result.payload ? result.payload.data || {} : {};
  const token = data.csrfToken || null;
  return {
    status: result.status,
    hasCsrfToken: Boolean(token),
    csrfToken: CsrfTokenService.safeTokenSummary(token),
    headerName: data.headerName || null,
    expiresAtPresent: Boolean(data.expiresAt),
    contextType: data.contextType || null,
    csrfCookie: result.cookies.find((cookie) => cookie.name === names.csrf)
      ? safeCookie(result.cookies.find((cookie) => cookie.name === names.csrf))
      : null,
    authTokenLikeStringsPrinted: false
  };
}

function pass(name, detail) {
  return { name, ok: true, detail: detail || null };
}

function fail(name, detail) {
  return { name, ok: false, detail: detail || null };
}

function headersWithCsrf(token, origin = ALLOWED_ORIGIN) {
  return {
    origin,
    'x-csrf-token': token
  };
}

function protectedRoutePaths() {
  return AuthRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort()
    }));
}

function routeExists(path, method) {
  return protectedRoutePaths().some((route) => (
    route.path === path && route.methods.includes(String(method || '').toLowerCase())
  ));
}

function issueExpiredTokenFor(req) {
  return CsrfTokenService.issueToken(req, {
    nowMs: Date.now() - 2000,
    ttlSeconds: 1
  }).token;
}

function sessionAccessToken() {
  return Token.GetAccessToken({
    id_login: 'QA_D2_3A_CSRF_USER',
    id_session: 'QA_D2_3A_CSRF_SESSION',
    id_business: 'QA_D2_3A_CSRF_BUSINESS',
    email: 'qa.d2.csrf@example.test',
    name: 'QA D2 CSRF',
    rol: 'admin'
  }).token;
}

async function validate() {
  const checks = [];

  await withEnv(d2Env(), async () => {
    const names = cookieNames();
    const bootstrap = await runCsrfEndpoint({
      headers: { origin: ALLOWED_ORIGIN }
    });
    const csrfToken = bootstrap.payload && bootstrap.payload.data ? bootstrap.payload.data.csrfToken : null;
    const csrfCookie = cookieValue(bootstrap, names.csrf);

    checks.push(
      bootstrap.status === 200 &&
      csrfToken &&
      csrfCookie &&
      csrfToken === csrfCookie &&
      bootstrap.payload.data.headerName === 'X-CSRF-Token'
        ? pass('GET /api/auth/csrf emits matching token/cookie/header metadata', endpointDetail(bootstrap, names))
        : fail('GET /api/auth/csrf emits matching token/cookie/header metadata', endpointDetail(bootstrap, names))
    );

    const csrfCookieDetail = bootstrap.cookies.find((cookie) => cookie.name === names.csrf);
    checks.push(
      csrfCookieDetail &&
      csrfCookieDetail.options &&
      csrfCookieDetail.options.httpOnly === false
        ? pass('CSRF cookie is readable by JS and not HttpOnly', safeCookie(csrfCookieDetail))
        : fail('CSRF cookie is readable by JS and not HttpOnly', csrfCookieDetail ? safeCookie(csrfCookieDetail) : null)
    );

    checks.push(
      csrfToken &&
      !String(csrfToken).includes('Bearer ') &&
      !String(csrfToken).includes('v2.') &&
      !String(csrfToken).includes('__Host-medsync_at') &&
      !String(csrfToken).includes('__Host-medsync_rt')
        ? pass('CSRF token does not expose access/refresh token markers', {
          csrfToken: CsrfTokenService.safeTokenSummary(csrfToken)
        })
        : fail('CSRF token does not expose access/refresh token markers', {
          csrfToken: CsrfTokenService.safeTokenSummary(csrfToken)
        })
    );

    const missingBoth = runCsrfMiddleware({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN }
    });
    checks.push(
      missingBoth.status === 403 && !missingBoth.nextCalled
        ? pass('D2 mutation without CSRF returns 403', { status: missingBoth.status, reason: missingBoth.payload.reason })
        : fail('D2 mutation without CSRF returns 403', missingBoth)
    );

    const missingHeader = runCsrfMiddleware({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      cookies: { [names.csrf]: csrfToken }
    });
    checks.push(
      missingHeader.status === 403 && missingHeader.payload.reason === 'missing_header'
        ? pass('D2 mutation with missing CSRF header returns 403', { status: missingHeader.status, reason: missingHeader.payload.reason })
        : fail('D2 mutation with missing CSRF header returns 403', missingHeader)
    );

    const missingCookie = runCsrfMiddleware({
      method: 'POST',
      url: '/api/auth/login',
      headers: headersWithCsrf(csrfToken)
    });
    checks.push(
      missingCookie.status === 403 && missingCookie.payload.reason === 'missing_cookie'
        ? pass('D2 mutation with missing CSRF cookie returns 403', { status: missingCookie.status, reason: missingCookie.payload.reason })
        : fail('D2 mutation with missing CSRF cookie returns 403', missingCookie)
    );

    const invalidToken = runCsrfMiddleware({
      method: 'POST',
      url: '/api/auth/login',
      headers: headersWithCsrf(INVALID_TOKEN),
      cookies: { [names.csrf]: INVALID_TOKEN }
    });
    checks.push(
      invalidToken.status === 403
        ? pass('D2 mutation with invalid CSRF token returns 403', { status: invalidToken.status, reason: invalidToken.payload.reason })
        : fail('D2 mutation with invalid CSRF token returns 403', invalidToken)
    );

    const expiredReq = createReq({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN }
    });
    const expiredToken = issueExpiredTokenFor(expiredReq);
    const expired = runCsrfMiddleware({
      method: 'POST',
      url: '/api/auth/login',
      headers: headersWithCsrf(expiredToken),
      cookies: { [names.csrf]: expiredToken }
    });
    checks.push(
      expired.status === 403 && expired.payload.reason === 'expired'
        ? pass('D2 mutation with expired CSRF token returns 403', { status: expired.status, reason: expired.payload.reason })
        : fail('D2 mutation with expired CSRF token returns 403', expired)
    );

    const badOrigin = runCsrfMiddleware({
      method: 'POST',
      url: '/api/auth/login',
      headers: headersWithCsrf(csrfToken, BLOCKED_ORIGIN),
      cookies: { [names.csrf]: csrfToken }
    });
    checks.push(
      badOrigin.status === 403 && badOrigin.payload.reason === 'origin_not_allowed'
        ? pass('D2 mutation with disallowed Origin returns 403', { status: badOrigin.status, reason: badOrigin.payload.reason })
        : fail('D2 mutation with disallowed Origin returns 403', badOrigin)
    );

    const valid = runCsrfMiddleware({
      method: 'POST',
      url: '/api/auth/login',
      headers: headersWithCsrf(csrfToken),
      cookies: { [names.csrf]: csrfToken }
    });
    checks.push(
      valid.status === 200 && valid.nextCalled && valid.csrfContext === 'preauth'
        ? pass('D2 mutation with valid CSRF and allowed Origin reaches next middleware', {
          status: valid.status,
          context: valid.csrfContext
        })
        : fail('D2 mutation with valid CSRF and allowed Origin reaches next middleware', valid)
    );

    checks.push(
      routeExists('/csrf', 'get')
        ? pass('GET /api/auth/csrf route exists', { route: '/csrf', method: 'get' })
        : fail('GET /api/auth/csrf route exists', protectedRoutePaths())
    );

    const loginPreauth = runCsrfMiddleware({
      method: 'POST',
      url: '/api/auth/login',
      headers: headersWithCsrf(csrfToken),
      cookies: { [names.csrf]: csrfToken }
    });
    checks.push(
      loginPreauth.nextCalled
        ? pass('Login D2 accepts valid pre-auth CSRF before controller', { status: loginPreauth.status, context: loginPreauth.csrfContext })
        : fail('Login D2 accepts valid pre-auth CSRF before controller', loginPreauth)
    );

    const refreshMissing = runCsrfMiddleware({
      method: 'POST',
      url: '/api/auth/refreshToken',
      headers: { origin: ALLOWED_ORIGIN }
    });
    checks.push(
      refreshMissing.status === 403
        ? pass('Refresh D2 requires CSRF', { status: refreshMissing.status, reason: refreshMissing.payload.reason })
        : fail('Refresh D2 requires CSRF', refreshMissing)
    );

    const accessToken = sessionAccessToken();
    const sessionNames = AuthCookieConfig.getCookieNames(AuthCookieConfig.getAuthCookieConfig());
    const sessionBootstrap = await runCsrfEndpoint({
      headers: { origin: ALLOWED_ORIGIN },
      cookies: { [sessionNames.access]: accessToken }
    });
    const sessionCsrf = sessionBootstrap.payload && sessionBootstrap.payload.data
      ? sessionBootstrap.payload.data.csrfToken
      : null;
    const logoutValid = runCsrfMiddleware({
      method: 'PUT',
      url: '/api/auth/close',
      tokenDecode: {
        id_login: 'QA_D2_3A_CSRF_USER',
        id_session: 'QA_D2_3A_CSRF_SESSION'
      },
      headers: headersWithCsrf(sessionCsrf),
      cookies: { [names.csrf]: sessionCsrf }
    });
    const logoutMissing = runCsrfMiddleware({
      method: 'PUT',
      url: '/api/auth/close',
      tokenDecode: {
        id_login: 'QA_D2_3A_CSRF_USER',
        id_session: 'QA_D2_3A_CSRF_SESSION'
      },
      headers: { origin: ALLOWED_ORIGIN }
    });
    checks.push(
      sessionBootstrap.status === 200 &&
      sessionBootstrap.payload.data.contextType === 'session' &&
      logoutValid.nextCalled &&
      logoutMissing.status === 403
        ? pass('Logout D2 requires CSRF and accepts valid session-bound CSRF', {
          bootstrapContext: sessionBootstrap.payload.data.contextType,
          validStatus: logoutValid.status,
          missingStatus: logoutMissing.status,
          csrfToken: CsrfTokenService.safeTokenSummary(sessionCsrf)
        })
        : fail('Logout D2 requires CSRF and accepts valid session-bound CSRF', {
          sessionBootstrap: endpointDetail(sessionBootstrap, names),
          logoutValid,
          logoutMissing
        })
    );

    const preauthEndpointChecks = [
      ['sendOtp pre-auth CSRF applies', 'POST', '/api/auth/sendOtp'],
      ['validateOtp pre-auth CSRF applies', 'POST', '/api/auth/validateOtp'],
      ['resetPassword pre-auth CSRF applies', 'PUT', '/api/auth/resetPassword']
    ].map(([name, method, url]) => {
      const response = runCsrfMiddleware({
        method,
        url,
        headers: headersWithCsrf(csrfToken),
        cookies: { [names.csrf]: csrfToken }
      });
      return response.nextCalled
        ? pass(name, { status: response.status, context: response.csrfContext })
        : fail(name, response);
    });
    checks.push(...preauthEndpointChecks);
  });

  await withEnv(legacyEnv(), async () => {
    const legacyNoCsrf = runCsrfMiddleware({
      method: 'POST',
      url: '/api/auth/login'
    });

    checks.push(
      legacyNoCsrf.status === 200 && legacyNoCsrf.nextCalled
        ? pass('Legacy with CSRF_ENABLED=false remains intact', { status: legacyNoCsrf.status })
        : fail('Legacy with CSRF_ENABLED=false remains intact', legacyNoCsrf)
    );
  });

  return {
    ok: checks.every((check) => check.ok),
    mode: 'csrf auth endpoints',
    dbAccess: false,
    secretsPrinted: false,
    csrfTokensPrinted: false,
    cookiesPrinted: false,
    authTokensPrinted: false,
    checks
  };
}

function status() {
  return {
    ok: true,
    script: 'd2-csrf-auth-endpoints',
    dbAccess: false,
    commands: ['status', 'validate', 'full'],
    requiredEnvForRuntime: [
      'CSRF_ENABLED=true',
      'CSRF_TOKEN_SECRET',
      'CSRF_HEADER_NAME=X-CSRF-Token',
      'CSRF_ALLOWED_ORIGINS=<exact origins>'
    ],
    routeSummary: protectedRoutePaths(),
    secretsPrinted: false,
    csrfTokensPrinted: false,
    cookiesPrinted: false,
    authTokensPrinted: false
  };
}

async function full() {
  const steps = [];
  steps.push({ step: 'status', result: status() });
  steps.push({ step: 'validate', result: await validate() });
  return {
    ok: steps.every((step) => step.result && step.result.ok !== false),
    steps
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

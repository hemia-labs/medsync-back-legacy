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

const QA_REFRESH_TOKEN = 'v2.11111111-1111-4111-8111-111111111111.qa_mock_value_not_printed';

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
    email: 'qa.d2.login@example.test',
    name: 'QA D2 Login User',
    telephone: '9993000222',
    id_login: 'QA_D2_LOGIN_USER',
    id_rol: 'QA_D2_ROLE',
    rol: 'admin',
    id_business: 'QA_D2_BUSINESS',
    id_session: 'QA_D2_SESSION',
    business_name: 'QA D2 Business',
    business_slug: 'qa-d2-business',
    business_status: 'active'
  }).token;
}

function fakeLoginResponse(options) {
  return responseData.success({
    token: fakeAccessToken(),
    refresh_token: options && options.refresh ? QA_REFRESH_TOKEN : null,
    permisos: ['qa.d2.login.read'],
    tenantOperational: {
      allowed: true,
      code: null,
      reasonCode: null,
      tenantStatus: null,
      status: null
    },
    tenantOperationalMessage: null
  }, 'QA mock login OK');
}

function createReq(body) {
  return {
    body: body || {},
    ip: '127.0.0.1',
    method: 'POST',
    originalUrl: '/api/auth/login',
    authIdentity: {
      phone: '9993000222'
    },
    get() {
      return 'QA_D2_LOGIN_SET_COOKIE';
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

async function withMockedLogin(env, body) {
  const envSnapshot = snapshotEnv();
  const originalLogin = AuthDao.login;
  const originalInfo = console.info;
  const res = createRes();

  try {
    setEnv(env);
    console.info = function noop() {};
    AuthDao.login = async (daoBody) => fakeLoginResponse({ refresh: daoBody && daoBody.refresh === true });

    await AuthController.login(createReq(body), res, () => {});

    return {
      status: res.statusCode,
      cookieAuthEnabled: AuthCookieConfig.getAuthCookieConfig().isCookieAuthEnabled,
      cookies: res.cookies.map(safeCookie),
      hasForbiddenResponseKeys: containsForbiddenKeys(res.payload),
      payloadShape: {
        hasData: Boolean(res.payload && res.payload.data),
        authenticated: Boolean(res.payload && res.payload.data && res.payload.data.authenticated),
        hasLegacyToken: Boolean(res.payload && res.payload.data && res.payload.data.token),
        hasLegacyRefreshToken: Boolean(res.payload && res.payload.data && res.payload.data.refresh_token),
        hasPermissions: Boolean(res.payload && res.payload.data && (
          Array.isArray(res.payload.data.permissions) ||
          Array.isArray(res.payload.data.permisos)
        ))
      }
    };
  } finally {
    AuthDao.login = originalLogin;
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
  const legacy = await withMockedLogin({
    AUTH_COOKIE_MODE: 'legacy',
    BROWSER_AUTH_TRANSPORT: 'authorization'
  }, { refresh: true });

  checks.push(
    legacy.status === 200 &&
    legacy.cookieAuthEnabled === false &&
    legacy.cookies.length === 0 &&
    legacy.payloadShape.hasLegacyToken &&
    legacy.payloadShape.hasLegacyRefreshToken
      ? pass('legacy mode keeps JSON token contract and sets no cookies', {
        cookieCount: legacy.cookies.length,
        hasLegacyToken: legacy.payloadShape.hasLegacyToken,
        hasLegacyRefreshToken: legacy.payloadShape.hasLegacyRefreshToken
      })
      : fail('legacy mode keeps JSON token contract and sets no cookies', legacy)
  );

  const partial = await withMockedLogin({
    AUTH_COOKIE_MODE: 'd2',
    BROWSER_AUTH_TRANSPORT: 'authorization'
  }, { refresh: true });

  checks.push(
    partial.status === 200 &&
    partial.cookieAuthEnabled === false &&
    partial.cookies.length === 0 &&
    partial.payloadShape.hasLegacyToken
      ? pass('partial D2 flags do not enable cookie login', {
        cookieCount: partial.cookies.length,
        hasLegacyToken: partial.payloadShape.hasLegacyToken
      })
      : fail('partial D2 flags do not enable cookie login', partial)
  );

  const d2 = await withMockedLogin(baseD2Env(), { refresh: true });
  const accessCookie = cookieByName(d2, '__Host-medsync_at');
  const refreshCookie = cookieByName(d2, '__Host-medsync_rt');

  checks.push(
    d2.status === 200 &&
    d2.cookieAuthEnabled === true &&
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
      ? pass('d2 login sets access/refresh cookies and strips tokens from JSON', {
        cookies: d2.cookies,
        authenticated: d2.payloadShape.authenticated,
        hasForbiddenResponseKeys: d2.hasForbiddenResponseKeys
      })
      : fail('d2 login sets access/refresh cookies and strips tokens from JSON', d2)
  );

  const d2FrontendNoRefresh = await withMockedLogin(baseD2Env(), { refresh: false });
  const noRefreshAccessCookie = cookieByName(d2FrontendNoRefresh, '__Host-medsync_at');
  const noRefreshRefreshCookie = cookieByName(d2FrontendNoRefresh, '__Host-medsync_rt');

  checks.push(
    d2FrontendNoRefresh.status === 200 &&
    noRefreshAccessCookie &&
    noRefreshRefreshCookie &&
    !noRefreshAccessCookie.maxAgeConfigured &&
    !noRefreshRefreshCookie.maxAgeConfigured &&
    !noRefreshAccessCookie.expiresConfigured &&
    !noRefreshRefreshCookie.expiresConfigured &&
    !d2FrontendNoRefresh.hasForbiddenResponseKeys
      ? pass('d2 login ignores frontend refresh=false and follows server-side refresh policy', {
        cookies: d2FrontendNoRefresh.cookies,
        hasForbiddenResponseKeys: d2FrontendNoRefresh.hasForbiddenResponseKeys
      })
      : fail('d2 login ignores frontend refresh=false and follows server-side refresh policy', d2FrontendNoRefresh)
  );

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}

function status() {
  return {
    ok: true,
    script: 'd2-login-set-cookie',
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

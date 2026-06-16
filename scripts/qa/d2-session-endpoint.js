'use strict';

require('../../src/config/env');

const fs = require('fs');
const path = require('path');
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

const INVALID_TOKEN = 'qa.invalid.jwt.not_printed';

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

function legacyEnv(overrides) {
  return Object.assign({
    AUTH_COOKIE_MODE: 'legacy',
    BROWSER_AUTH_TRANSPORT: 'authorization'
  }, overrides || {});
}

function fakeAccessToken() {
  return Token.GetAccessToken({
    email: 'qa.d2.session@example.test',
    name: 'QA D2 Session User',
    telephone: '9993000666',
    id_login: 'QA_D2_SESSION_USER',
    id_rol: 'QA_D2_ROLE',
    rol: 'admin',
    role_name: 'QA Admin',
    id_business: 'QA_D2_BUSINESS',
    id_session: 'QA_D2_SESSION',
    business_name: 'QA D2 Business',
    business_slug: 'qa-d2-business',
    business_status: 'active',
    business_subscription_status: 'active'
  }).token;
}

function fakeDaoSessionResponse() {
  return responseData.success({
    token: fakeAccessToken(),
    refresh_token: null,
    permisos: ['patients.read', 'appointments.write'],
    business: {
      id_business: 'QA_D2_BUSINESS',
      name: 'QA D2 Business',
      slug: 'qa-d2-business',
      status: 'active',
      subscription_status: 'active',
      plan: null
    },
    tenantOperational: {
      allowed: true,
      code: null,
      reasonCode: null,
      tenantStatus: null
    },
    tenantOperationalMessage: null
  }, 'QA mock session OK');
}

function createReq(options) {
  return {
    body: {},
    headers: options.headers || {},
    cookies: options.cookies || {},
    ip: '127.0.0.1',
    method: 'GET',
    url: '/api/auth/session',
    originalUrl: '/api/auth/session',
    get() {
      return 'QA_D2_SESSION_ENDPOINT';
    }
  };
}

function safeCookie(cookie) {
  const options = cookie.options || {};
  const expires = options.expires instanceof Date ? options.expires.toISOString() : null;

  return {
    name: cookie.name,
    valueCleared: cookie.value === '',
    httpOnly: options.httpOnly === true,
    secure: options.secure === true,
    sameSite: options.sameSite || null,
    path: options.path || null,
    domainConfigured: Boolean(options.domain),
    maxAgeZero: options.maxAge === 0,
    expiresAtEpoch: expires === new Date(0).toISOString()
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
      done();
      return this;
    }
  };
}

function normalizeKey(key) {
  return String(key || '').replace(/[_-]/g, '').toLowerCase();
}

function containsForbiddenKeys(value) {
  const forbidden = [
    'token',
    'accesstoken',
    'refreshtoken',
    'idrefreshtoken',
    'idsession',
    'tokenhash',
    'tokenfingerprint',
    'csrf',
    'csrftoken',
    'csrfsecret'
  ];

  if (!value || typeof value !== 'object') {
    return false;
  }

  return Object.keys(value).some((key) => {
    if (forbidden.includes(normalizeKey(key))) {
      return true;
    }

    return containsForbiddenKeys(value[key]);
  });
}

function payloadData(result) {
  return result && result.payload ? result.payload.data : null;
}

function safeSessionDetail(result) {
  const data = payloadData(result) || {};

  return {
    status: result.status,
    authenticated: data.authenticated === true,
    anonymous: data.authenticated === false,
    userKeys: data.user ? Object.keys(data.user).sort() : [],
    roleKeys: data.role ? Object.keys(data.role).sort() : [],
    permissionCount: Array.isArray(data.permissions) ? data.permissions.length : 0,
    businessKeys: data.business ? Object.keys(data.business).sort() : [],
    tenantOperationalKeys: data.tenantOperational ? Object.keys(data.tenantOperational).sort() : [],
    accessExpiresAtPresent: Boolean(data.accessExpiresAt),
    sessionState: data.sessionState || null,
    cookieCount: result.cookies.length,
    daoCalled: result.daoCalled,
    hasForbiddenResponseKeys: result.hasForbiddenResponseKeys
  };
}

function hasSessionShape(result) {
  const data = payloadData(result);

  return Boolean(
    data &&
    data.authenticated === true &&
    data.user &&
    data.user.id_login &&
    data.role &&
    Object.prototype.hasOwnProperty.call(data.role, 'code') &&
    Object.prototype.hasOwnProperty.call(data.role, 'name') &&
    Array.isArray(data.permissions) &&
    data.business &&
    Object.prototype.hasOwnProperty.call(data.business, 'subscriptionStatus') &&
    Object.prototype.hasOwnProperty.call(data.business, 'plan') &&
    data.tenantOperational &&
    Object.prototype.hasOwnProperty.call(data.tenantOperational, 'allowed') &&
    data.sessionState === 'active'
  );
}

function runSessionPipeline(reqOptions) {
  return new Promise((resolve) => {
    const req = createReq(reqOptions || {});
    const result = {
      authNextCalled: false,
      status: null,
      cookies: [],
      payload: null,
      daoCalled: false,
      hasForbiddenResponseKeys: false
    };
    const res = createRes(finish);
    let finished = false;

    function finish() {
      if (finished) {
        return;
      }
      finished = true;
      result.status = res.statusCode;
      result.cookies = res.cookies.map(safeCookie);
      result.payload = res.payload;
      result.hasForbiddenResponseKeys = containsForbiddenKeys(res.payload);
      resolve(result);
    }

    function next(error) {
      if (error) {
        finish();
        return;
      }
      result.authNextCalled = true;
      AuthController.session(req, res, () => finish());
    }

    Token.OptionalAuth.handle(req, res, next);
  });
}

async function withMockedSession(env, reqOptions, daoBehavior) {
  const envSnapshot = snapshotEnv();
  const originalSession = AuthDao.session;
  const originalInfo = console.info;
  const behavior = daoBehavior || {};
  let daoCalled = false;

  try {
    setEnv(env);
    console.info = function noop() {};
    AuthDao.session = async () => {
      daoCalled = true;
      return behavior.response || fakeDaoSessionResponse();
    };

    const result = await runSessionPipeline(reqOptions || {});
    result.daoCalled = daoCalled;
    return result;
  } finally {
    AuthDao.session = originalSession;
    console.info = originalInfo;
    restoreEnv(envSnapshot);
  }
}

function cookieByName(result, name) {
  return result.cookies.find((cookie) => cookie.name === name) || null;
}

function allClearCookiesValid(result, names) {
  return [names.access, names.refresh, names.csrf].every((name) => {
    const cookie = cookieByName(result, name);
    return cookie &&
      cookie.valueCleared &&
      cookie.maxAgeZero &&
      cookie.expiresAtEpoch &&
      cookie.secure &&
      cookie.sameSite === 'lax' &&
      cookie.path === '/' &&
      !cookie.domainConfigured;
  });
}

function routeScope() {
  const routePath = path.join(__dirname, '../../src/routes/mysql/auth.js');
  const source = fs.readFileSync(routePath, 'utf8');

  return {
    sessionRoute: /router\.get\(['"]\/session['"]/.test(source),
    csrfRoute: /router\.(get|post|put|patch|delete)\(['"]\/csrf['"]/.test(source)
  };
}

function pass(name, detail) {
  return { name, ok: true, detail: detail || null };
}

function fail(name, detail) {
  return { name, ok: false, detail: detail || null };
}

async function validate() {
  const checks = [];
  const token = fakeAccessToken();
  const d2Env = baseD2Env();
  const d2Names = AuthCookieConfig.getCookieNames({ env: d2Env });

  const legacyAnonymous = await withMockedSession(legacyEnv(), {});
  checks.push(
    legacyAnonymous.status === 200 &&
    payloadData(legacyAnonymous).authenticated === false &&
    !legacyAnonymous.daoCalled &&
    legacyAnonymous.cookies.length === 0
      ? pass('legacy session without Authorization returns authenticated false', safeSessionDetail(legacyAnonymous))
      : fail('legacy session without Authorization returns authenticated false', safeSessionDetail(legacyAnonymous))
  );

  const legacyAuthorized = await withMockedSession(legacyEnv(), {
    headers: { authorization: `Bearer ${token}` }
  });
  checks.push(
    legacyAuthorized.status === 200 &&
    legacyAuthorized.daoCalled &&
    hasSessionShape(legacyAuthorized) &&
    !legacyAuthorized.hasForbiddenResponseKeys &&
    legacyAuthorized.cookies.length === 0
      ? pass('legacy session with Authorization returns tokenless session', safeSessionDetail(legacyAuthorized))
      : fail('legacy session with Authorization returns tokenless session', safeSessionDetail(legacyAuthorized))
  );

  const d2Anonymous = await withMockedSession(d2Env, {});
  checks.push(
    d2Anonymous.status === 200 &&
    payloadData(d2Anonymous).authenticated === false &&
    !d2Anonymous.daoCalled &&
    d2Anonymous.cookies.length === 0
      ? pass('d2 session without access cookie returns authenticated false', safeSessionDetail(d2Anonymous))
      : fail('d2 session without access cookie returns authenticated false', safeSessionDetail(d2Anonymous))
  );

  const d2Cookie = await withMockedSession(d2Env, {
    cookies: { [d2Names.access]: token }
  });
  checks.push(
    d2Cookie.status === 200 &&
    d2Cookie.daoCalled &&
    hasSessionShape(d2Cookie) &&
    !d2Cookie.hasForbiddenResponseKeys &&
    d2Cookie.cookies.length === 0
      ? pass('d2 session uses access cookie and returns tokenless session shape', safeSessionDetail(d2Cookie))
      : fail('d2 session uses access cookie and returns tokenless session shape', safeSessionDetail(d2Cookie))
  );

  const d2NoFallback = await withMockedSession(d2Env, {
    headers: { authorization: `Bearer ${token}` }
  });
  checks.push(
    d2NoFallback.status === 200 &&
    payloadData(d2NoFallback).authenticated === false &&
    !d2NoFallback.daoCalled
      ? pass('d2 session does not fall back to Authorization without access cookie', safeSessionDetail(d2NoFallback))
      : fail('d2 session does not fall back to Authorization without access cookie', safeSessionDetail(d2NoFallback))
  );

  const d2Invalid = await withMockedSession(d2Env, {
    cookies: { [d2Names.access]: INVALID_TOKEN }
  });
  checks.push(
    d2Invalid.status === 401 &&
    !d2Invalid.daoCalled &&
    allClearCookiesValid(d2Invalid, d2Names) &&
    !d2Invalid.hasForbiddenResponseKeys
      ? pass('d2 session invalid access cookie returns 401 and clears cookies', safeSessionDetail(d2Invalid))
      : fail('d2 session invalid access cookie returns 401 and clears cookies', safeSessionDetail(d2Invalid))
  );

  const d2Revoked = await withMockedSession(d2Env, {
    cookies: { [d2Names.access]: token }
  }, {
    response: responseData.notSuccess('QA revoked session')
  });
  checks.push(
    d2Revoked.status === 401 &&
    d2Revoked.daoCalled &&
    allClearCookiesValid(d2Revoked, d2Names) &&
    !d2Revoked.hasForbiddenResponseKeys
      ? pass('d2 session revoked server session returns 401 and clears cookies', safeSessionDetail(d2Revoked))
      : fail('d2 session revoked server session returns 401 and clears cookies', safeSessionDetail(d2Revoked))
  );

  const scope = routeScope();
  checks.push(
    scope.sessionRoute && scope.csrfRoute
      ? pass('auth routes expose session and csrf bootstrap routes', scope)
      : fail('auth routes expose session and csrf bootstrap routes', scope)
  );

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}

function status() {
  return {
    ok: true,
    script: 'd2-session-endpoint',
    dbAccess: false,
    fixtures: false,
    cleanupRequired: false,
    secretsPrinted: false,
    tokensPrinted: false,
    cookiesPrinted: false,
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

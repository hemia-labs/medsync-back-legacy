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
    email: 'qa.d2.logout@example.test',
    name: 'QA D2 Logout User',
    telephone: '9993000555',
    id_login: 'QA_D2_LOGOUT_USER',
    id_rol: 'QA_D2_ROLE',
    rol: 'admin',
    id_business: 'QA_D2_BUSINESS',
    id_session: 'QA_D2_SESSION',
    business_name: 'QA D2 Business',
    business_slug: 'qa-d2-business',
    business_status: 'active'
  }).token;
}

function createReq(options) {
  return {
    body: Object.assign({}, options.body || {}),
    headers: options.headers || {},
    cookies: options.cookies || {},
    ip: '127.0.0.1',
    method: 'PUT',
    url: '/api/auth/close',
    originalUrl: '/api/auth/close',
    get() {
      return 'QA_D2_LOGOUT_CLEAR_COOKIES';
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

function runLogoutPipeline(reqOptions) {
  return new Promise((resolve) => {
    const req = createReq(reqOptions || {});
    const result = {
      authNextCalled: false,
      status: null,
      cookieAuthEnabled: AuthCookieConfig.getAuthCookieConfig().isCookieAuthEnabled,
      cookies: [],
      daoBody: null,
      hasForbiddenResponseKeys: false,
      payloadShape: {
        hasData: false,
        success: false
      }
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
      result.hasForbiddenResponseKeys = containsForbiddenKeys(res.payload);
      result.payloadShape = {
        hasData: Boolean(res.payload && res.payload.data),
        success: Boolean(res.payload && res.payload.data && res.payload.data.success)
      };
      resolve(result);
    }

    function next(error) {
      if (error) {
        finish();
        return;
      }
      result.authNextCalled = true;
      AuthController.close(req, res, () => finish());
    }

    Token.Auth.handle(req, res, next);
  });
}

async function withMockedLogout(env, reqOptions, daoBehavior) {
  const envSnapshot = snapshotEnv();
  const originalClose = AuthDao.close;
  const originalInfo = console.info;
  const behavior = daoBehavior || {};
  let daoBody = null;

  try {
    setEnv(env);
    console.info = function noop() {};
    AuthDao.close = async (body) => {
      daoBody = Object.assign({}, body || {});

      if (behavior.throwError) {
        const error = new Error('QA mock logout failure');
        error.status = behavior.status || 503;
        throw error;
      }

      return behavior.response || responseData.success({ success: true }, 'QA mock logout OK');
    };

    const result = await runLogoutPipeline(reqOptions);
    result.daoBody = daoBody;
    return result;
  } finally {
    AuthDao.close = originalClose;
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

async function validate() {
  const checks = [];
  const token = fakeAccessToken();
  const d2Env = baseD2Env();
  const d2Names = AuthCookieConfig.getCookieNames({ env: d2Env });

  const legacy = await withMockedLogout(legacyEnv(), {
    headers: { authorization: `Bearer ${token}` }
  });

  checks.push(
    legacy.status === 200 &&
    legacy.authNextCalled &&
    legacy.cookies.length === 0 &&
    legacy.daoBody &&
    legacy.daoBody.id_login === 'QA_D2_LOGOUT_USER' &&
    legacy.daoBody.id_session === 'QA_D2_SESSION'
      ? pass('legacy logout uses Authorization and sets no D2 clear cookies', {
        status: legacy.status,
        cookieCount: legacy.cookies.length,
        daoBody: legacy.daoBody
      })
      : fail('legacy logout uses Authorization and sets no D2 clear cookies', legacy)
  );

  const d2 = await withMockedLogout(d2Env, {
    cookies: { [d2Names.access]: token }
  });

  checks.push(
    d2.status === 200 &&
    d2.authNextCalled &&
    d2.daoBody &&
    d2.daoBody.id_login === 'QA_D2_LOGOUT_USER' &&
    d2.daoBody.id_session === 'QA_D2_SESSION' &&
    allClearCookiesValid(d2, d2Names) &&
    cookieByName(d2, d2Names.access).httpOnly &&
    cookieByName(d2, d2Names.refresh).httpOnly &&
    cookieByName(d2, d2Names.csrf).httpOnly === false &&
    !d2.hasForbiddenResponseKeys
      ? pass('d2 logout uses access cookie, revokes server and clears auth/csrf cookies', {
        status: d2.status,
        cookies: d2.cookies,
        daoBody: d2.daoBody,
        hasForbiddenResponseKeys: d2.hasForbiddenResponseKeys
      })
      : fail('d2 logout uses access cookie, revokes server and clears auth/csrf cookies', d2)
  );

  const d2NoFallback = await withMockedLogout(d2Env, {
    headers: { authorization: `Bearer ${token}` }
  });

  checks.push(
    d2NoFallback.status === 401 &&
    !d2NoFallback.authNextCalled &&
    !d2NoFallback.daoBody &&
    d2NoFallback.cookies.length === 0
      ? pass('d2 logout does not fall back to Authorization without access cookie', {
        status: d2NoFallback.status,
        authNextCalled: d2NoFallback.authNextCalled,
        cookieCount: d2NoFallback.cookies.length
      })
      : fail('d2 logout does not fall back to Authorization without access cookie', d2NoFallback)
  );

  const d2Failure = await withMockedLogout(d2Env, {
    cookies: { [d2Names.access]: token }
  }, {
    throwError: true,
    status: 503
  });

  checks.push(
    d2Failure.status === 503 &&
    d2Failure.authNextCalled &&
    d2Failure.daoBody &&
    allClearCookiesValid(d2Failure, d2Names)
      ? pass('d2 logout clears cookies best-effort when server revocation fails', {
        status: d2Failure.status,
        cookies: d2Failure.cookies,
        daoBody: d2Failure.daoBody
      })
      : fail('d2 logout clears cookies best-effort when server revocation fails', d2Failure)
  );

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}

function status() {
  return {
    ok: true,
    script: 'd2-logout-clear-cookies',
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

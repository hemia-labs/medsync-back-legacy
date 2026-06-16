'use strict';

require('../../src/config/env');

const Token = require('../../src/auth/authenticate');
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
    email: 'qa.d2.middleware@example.test',
    name: 'QA D2 Middleware User',
    telephone: '9993000444',
    id_login: 'QA_D2_MIDDLEWARE_USER',
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
    headers: options.headers || {},
    cookies: options.cookies || {},
    method: 'GET',
    url: '/',
    originalUrl: '/qa/d2/access-cookie-middleware'
  };
}

function createRes(done) {
  return {
    statusCode: null,
    payload: null,
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

function safeDecodeSummary(decoded) {
  if (!decoded) {
    return null;
  }

  return {
    id_login: decoded.id_login || null,
    id_session: decoded.id_session || null,
    id_business: decoded.id_business || null,
    rol: decoded.rol || null,
    check: decoded.check === true
  };
}

function runMiddleware(middleware, reqOptions) {
  return new Promise((resolve) => {
    const req = createReq(reqOptions || {});
    const result = {
      nextCalled: false,
      status: null,
      payloadStatus: null,
      tokenDecode: null
    };
    const res = createRes(finish);
    let finished = false;

    function finish() {
      if (finished) {
        return;
      }
      finished = true;
      result.status = res.statusCode;
      result.payloadStatus = res.payload ? res.payload.status : null;
      result.tokenDecode = safeDecodeSummary(req.tokenDecode);
      resolve(result);
    }

    function next() {
      result.nextCalled = true;
      finish();
    }

    middleware.handle(req, res, next);
  });
}

async function withEnv(env, fn) {
  const snapshot = snapshotEnv();

  try {
    setEnv(env);
    return await fn();
  } finally {
    restoreEnv(snapshot);
  }
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
  const d2CookieName = AuthCookieConfig.getCookieNames({
    env: baseD2Env()
  }).access;

  const legacyHeader = await withEnv(legacyEnv(), () => runMiddleware(Token.Auth, {
    headers: { authorization: `Bearer ${token}` }
  }));

  checks.push(
    legacyHeader.nextCalled &&
    legacyHeader.tokenDecode &&
    legacyHeader.tokenDecode.id_login === 'QA_D2_MIDDLEWARE_USER'
      ? pass('legacy Auth reads Authorization bearer', {
        nextCalled: legacyHeader.nextCalled,
        decoded: legacyHeader.tokenDecode
      })
      : fail('legacy Auth reads Authorization bearer', legacyHeader)
  );

  const legacyMissing = await withEnv(legacyEnv(), () => runMiddleware(Token.Auth, {
    cookies: { [d2CookieName]: token }
  }));

  checks.push(
    !legacyMissing.nextCalled &&
    legacyMissing.status === 401
      ? pass('legacy Auth does not require or read D2 cookie', {
        status: legacyMissing.status,
        nextCalled: legacyMissing.nextCalled
      })
      : fail('legacy Auth does not require or read D2 cookie', legacyMissing)
  );

  const d2Cookie = await withEnv(baseD2Env(), () => runMiddleware(Token.Auth, {
    cookies: { [d2CookieName]: token }
  }));

  checks.push(
    d2Cookie.nextCalled &&
    d2Cookie.tokenDecode &&
    d2Cookie.tokenDecode.id_session === 'QA_D2_SESSION'
      ? pass('d2 Auth reads access cookie and populates tokenDecode', {
        nextCalled: d2Cookie.nextCalled,
        decoded: d2Cookie.tokenDecode
      })
      : fail('d2 Auth reads access cookie and populates tokenDecode', d2Cookie)
  );

  const d2NoFallback = await withEnv(baseD2Env(), () => runMiddleware(Token.Auth, {
    headers: { authorization: `Bearer ${token}` }
  }));

  checks.push(
    !d2NoFallback.nextCalled &&
    d2NoFallback.status === 401 &&
    !d2NoFallback.tokenDecode
      ? pass('d2 Auth does not fall back to Authorization without access cookie', {
        status: d2NoFallback.status,
        nextCalled: d2NoFallback.nextCalled
      })
      : fail('d2 Auth does not fall back to Authorization without access cookie', d2NoFallback)
  );

  const d2InvalidCookie = await withEnv(baseD2Env(), () => runMiddleware(Token.Auth, {
    cookies: { [d2CookieName]: INVALID_TOKEN }
  }));

  checks.push(
    !d2InvalidCookie.nextCalled &&
    d2InvalidCookie.status === 401 &&
    !d2InvalidCookie.tokenDecode
      ? pass('d2 Auth rejects invalid access cookie', {
        status: d2InvalidCookie.status,
        nextCalled: d2InvalidCookie.nextCalled
      })
      : fail('d2 Auth rejects invalid access cookie', d2InvalidCookie)
  );

  const d2InvalidCookieNoFallback = await withEnv(baseD2Env(), () => runMiddleware(Token.Auth, {
    headers: { authorization: `Bearer ${token}` },
    cookies: { [d2CookieName]: INVALID_TOKEN }
  }));

  checks.push(
    !d2InvalidCookieNoFallback.nextCalled &&
    d2InvalidCookieNoFallback.status === 401 &&
    !d2InvalidCookieNoFallback.tokenDecode
      ? pass('d2 Auth rejects invalid cookie even when Authorization is present', {
        status: d2InvalidCookieNoFallback.status,
        nextCalled: d2InvalidCookieNoFallback.nextCalled
      })
      : fail('d2 Auth rejects invalid cookie even when Authorization is present', d2InvalidCookieNoFallback)
  );

  const d2OptionalCookie = await withEnv(baseD2Env(), () => runMiddleware(Token.OptionalAuth, {
    cookies: { [d2CookieName]: token }
  }));

  checks.push(
    d2OptionalCookie.nextCalled &&
    d2OptionalCookie.tokenDecode &&
    d2OptionalCookie.tokenDecode.id_login === 'QA_D2_MIDDLEWARE_USER'
      ? pass('d2 OptionalAuth reads access cookie when present', {
        nextCalled: d2OptionalCookie.nextCalled,
        decoded: d2OptionalCookie.tokenDecode
      })
      : fail('d2 OptionalAuth reads access cookie when present', d2OptionalCookie)
  );

  const d2OptionalMissing = await withEnv(baseD2Env(), () => runMiddleware(Token.OptionalAuth, {}));

  checks.push(
    d2OptionalMissing.nextCalled &&
    !d2OptionalMissing.tokenDecode &&
    d2OptionalMissing.status === null
      ? pass('d2 OptionalAuth continues without auth when cookie missing', {
        nextCalled: d2OptionalMissing.nextCalled,
        decoded: d2OptionalMissing.tokenDecode
      })
      : fail('d2 OptionalAuth continues without auth when cookie missing', d2OptionalMissing)
  );

  const d2OptionalNoFallback = await withEnv(baseD2Env(), () => runMiddleware(Token.OptionalAuth, {
    headers: { authorization: `Bearer ${token}` }
  }));

  checks.push(
    d2OptionalNoFallback.nextCalled &&
    !d2OptionalNoFallback.tokenDecode
      ? pass('d2 OptionalAuth does not fall back to Authorization without access cookie', {
        nextCalled: d2OptionalNoFallback.nextCalled,
        decoded: d2OptionalNoFallback.tokenDecode
      })
      : fail('d2 OptionalAuth does not fall back to Authorization without access cookie', d2OptionalNoFallback)
  );

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}

function status() {
  return {
    ok: true,
    script: 'd2-access-cookie-middleware',
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

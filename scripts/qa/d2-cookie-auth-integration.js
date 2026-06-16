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
  'ENVIRONMENT',
  'REQUIRE_ACTIVE_SESSION'
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
    CSRF_ENABLED: 'true',
    CORS_CREDENTIALS: 'true',
    CORS_ALLOWED_ORIGINS: 'https://app.example.test'
  }, overrides || {});
}

function legacyEnv(overrides) {
  return Object.assign({
    NODE_ENV: 'development',
    REQUIRE_ACTIVE_SESSION: 'true',
    AUTH_COOKIE_MODE: 'legacy',
    BROWSER_AUTH_TRANSPORT: 'authorization'
  }, overrides || {});
}

function createState() {
  return {
    idLogin: 'QA_D2_INTEGRATION_USER',
    idSession: 'QA_D2_INTEGRATION_SESSION',
    idBusiness: 'QA_D2_INTEGRATION_BUSINESS',
    active: true,
    refreshCounter: 0,
    currentRefresh: null,
    previousRefreshTokens: new Set()
  };
}

function issueAccessToken(state) {
  return Token.GetAccessToken({
    email: 'qa.d2.integration@example.test',
    name: 'QA D2 Integration User',
    telephone: '9993000777',
    id_login: state.idLogin,
    id_rol: 'QA_D2_ROLE',
    rol: 'admin',
    role_name: 'QA Admin',
    id_business: state.idBusiness,
    id_session: state.idSession,
    business_name: 'QA D2 Integration Business',
    business_slug: 'qa-d2-integration-business',
    business_status: 'active',
    business_subscription_status: 'active',
    business_plan: 'enterprise'
  }).token;
}

function issueRefreshToken(state) {
  state.refreshCounter += 1;
  state.currentRefresh = `QA_D2_INTEGRATION_REFRESH_${state.refreshCounter}_not_printed`;
  return state.currentRefresh;
}

function fakeSessionPayload(state, refreshToken) {
  return {
    token: issueAccessToken(state),
    refresh_token: refreshToken || null,
    permisos: ['patients.read', 'appointments.write', 'dashboard.view'],
    business: {
      id_business: state.idBusiness,
      name: 'QA D2 Integration Business',
      slug: 'qa-d2-integration-business',
      status: 'active',
      subscription_status: 'active',
      plan: 'enterprise'
    },
    tenantOperational: {
      allowed: true,
      code: null,
      reasonCode: null,
      tenantStatus: null
    },
    tenantOperationalMessage: null
  };
}

function mockDaoForState(state) {
  return {
    async login(body) {
      state.active = true;
      return responseData.success(
        fakeSessionPayload(state, body && body.refresh === true ? issueRefreshToken(state) : null),
        'QA D2 integration login OK'
      );
    },
    async session(body) {
      if (!state.active || !body || body.id_login !== state.idLogin || body.id_session !== state.idSession) {
        return responseData.notSuccess('QA D2 integration inactive session');
      }

      return responseData.success(fakeSessionPayload(state, null), 'QA D2 integration session OK');
    },
    async refreshToken(body) {
      const requested = body ? (body.id_refresh_token || body.refresh_token) : null;

      if (!state.active || !requested || requested !== state.currentRefresh) {
        return responseData.unauthorized('QA D2 integration refresh rejected');
      }

      state.previousRefreshTokens.add(state.currentRefresh);
      return responseData.success(fakeSessionPayload(state, issueRefreshToken(state)), 'QA D2 integration refresh OK');
    },
    async close(body) {
      if (body && body.id_login === state.idLogin && body.id_session === state.idSession) {
        state.active = false;
        if (state.currentRefresh) {
          state.previousRefreshTokens.add(state.currentRefresh);
        }
      }

      return responseData.success({ success: true }, 'QA D2 integration logout OK');
    }
  };
}

function createReq(options) {
  return {
    body: Object.assign({}, options.body || {}),
    headers: options.headers || {},
    cookies: options.cookies || {},
    ip: '127.0.0.1',
    method: options.method || 'GET',
    url: options.url || '/qa/d2/integration',
    originalUrl: options.url || '/qa/d2/integration',
    get() {
      return 'QA_D2_COOKIE_AUTH_INTEGRATION';
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
      done();
      return this;
    }
  };
}

function runController(handler, reqOptions) {
  return new Promise((resolve) => {
    const req = createReq(reqOptions || {});
    const res = createRes(finish);
    const result = {
      status: null,
      payload: null,
      cookies: []
    };
    let finished = false;

    function finish() {
      if (finished) {
        return;
      }
      finished = true;
      result.status = res.statusCode;
      result.payload = res.payload;
      result.cookies = res.cookies;
      resolve(result);
    }

    handler(req, res, () => finish());
  });
}

function runSession(reqOptions) {
  return new Promise((resolve) => {
    const req = createReq(Object.assign({
      method: 'GET',
      url: '/api/auth/session'
    }, reqOptions || {}));
    const res = createRes(finish);
    const result = {
      status: null,
      payload: null,
      cookies: []
    };
    let finished = false;

    function finish() {
      if (finished) {
        return;
      }
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
      AuthController.session(req, res, () => finish());
    });
  });
}

function runLogout(reqOptions) {
  return new Promise((resolve) => {
    const req = createReq(Object.assign({
      method: 'PUT',
      url: '/api/auth/close'
    }, reqOptions || {}));
    const res = createRes(finish);
    const result = {
      authNextCalled: false,
      status: null,
      payload: null,
      cookies: []
    };
    let finished = false;

    function finish() {
      if (finished) {
        return;
      }
      finished = true;
      result.status = res.statusCode;
      result.payload = res.payload;
      result.cookies = res.cookies;
      resolve(result);
    }

    Token.Auth.handle(req, res, (error) => {
      if (error) {
        finish();
        return;
      }
      result.authNextCalled = true;
      AuthController.close(req, res, () => finish());
    });
  });
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

  return Object.keys(value).some((key) => (
    forbidden.includes(normalizeKey(key)) || containsForbiddenKeys(value[key])
  ));
}

function payloadData(result) {
  return result && result.payload ? result.payload.data : null;
}

function rawCookie(result, name) {
  return result.cookies.find((cookie) => cookie.name === name) || null;
}

function cookieValue(result, name) {
  const cookie = rawCookie(result, name);
  return cookie ? cookie.value : null;
}

function safeCookie(cookie) {
  const options = cookie.options || {};

  return {
    name: cookie.name,
    hasValue: Boolean(cookie.value),
    valueCleared: cookie.value === '',
    httpOnly: options.httpOnly === true,
    secure: options.secure === true,
    sameSite: options.sameSite || null,
    path: options.path || null,
    domainConfigured: Boolean(options.domain),
    maxAgeConfigured: options.maxAge !== undefined,
    expiresConfigured: options.expires !== undefined,
    maxAgeZero: options.maxAge === 0
  };
}

function safeCookies(result) {
  return result.cookies.map(safeCookie);
}

function setCookiesValid(result, names) {
  const access = rawCookie(result, names.access);
  const refresh = rawCookie(result, names.refresh);

  return Boolean(
    access &&
    refresh &&
    access.value &&
    refresh.value &&
    access.options.httpOnly === true &&
    refresh.options.httpOnly === true &&
    access.options.secure === true &&
    refresh.options.secure === true &&
    access.options.sameSite === 'lax' &&
    refresh.options.sameSite === 'lax' &&
    access.options.path === '/' &&
    refresh.options.path === '/' &&
    access.options.maxAge === undefined &&
    refresh.options.maxAge === undefined &&
    access.options.expires === undefined &&
    refresh.options.expires === undefined
  );
}

function clearCookiesValid(result, names) {
  return [names.access, names.refresh, names.csrf].every((name) => {
    const cookie = rawCookie(result, name);
    return Boolean(
      cookie &&
      cookie.value === '' &&
      cookie.options.httpOnly === (name === names.csrf ? false : true) &&
      cookie.options.secure === true &&
      cookie.options.sameSite === 'lax' &&
      cookie.options.path === '/' &&
      cookie.options.maxAge === 0
    );
  });
}

function tokenless(result) {
  return !containsForbiddenKeys(result.payload);
}

function sessionShape(result) {
  const data = payloadData(result);

  return Boolean(
    data &&
    data.authenticated === true &&
    data.user &&
    data.role &&
    Array.isArray(data.permissions) &&
    data.business &&
    data.tenantOperational &&
    data.sessionState === 'active'
  );
}

function safeDetail(result) {
  const data = payloadData(result) || {};

  return {
    status: result.status,
    authenticated: data.authenticated === true,
    anonymous: data.authenticated === false,
    cookieCount: result.cookies.length,
    cookies: safeCookies(result),
    tokenless: tokenless(result),
    permissionCount: Array.isArray(data.permissions) ? data.permissions.length : 0,
    sessionState: data.sessionState || null
  };
}

function pass(name, detail) {
  return { name, ok: true, detail: detail || null };
}

function fail(name, detail) {
  return { name, ok: false, detail: detail || null };
}

async function withEnvAndDao(env, state, fn) {
  const envSnapshot = snapshotEnv();
  const originalLogin = AuthDao.login;
  const originalSession = AuthDao.session;
  const originalRefreshToken = AuthDao.refreshToken;
  const originalClose = AuthDao.close;
  const originalInfo = console.info;
  const mocked = mockDaoForState(state);

  try {
    setEnv(env);
    console.info = function noop() {};
    AuthDao.login = mocked.login;
    AuthDao.session = mocked.session;
    AuthDao.refreshToken = mocked.refreshToken;
    AuthDao.close = mocked.close;
    return await fn();
  } finally {
    AuthDao.login = originalLogin;
    AuthDao.session = originalSession;
    AuthDao.refreshToken = originalRefreshToken;
    AuthDao.close = originalClose;
    console.info = originalInfo;
    restoreEnv(envSnapshot);
  }
}

async function validateD2() {
  const checks = [];
  const state = createState();
  const env = baseD2Env();
  const names = AuthCookieConfig.getCookieNames({ env });

  await withEnvAndDao(env, state, async () => {
    const login = await runController(AuthController.login, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        param: '9993000777',
        pwd: 'not_printed',
        refresh: false
      }
    });
    const access1 = cookieValue(login, names.access);
    const refresh1 = cookieValue(login, names.refresh);

    checks.push(
      login.status === 200 &&
      setCookiesValid(login, names) &&
      tokenless(login)
        ? pass('d2 login sets session cookies and returns tokenless JSON', safeDetail(login))
        : fail('d2 login sets session cookies and returns tokenless JSON', safeDetail(login))
    );

    const session = await runSession({
      cookies: { [names.access]: access1 }
    });
    checks.push(
      session.status === 200 &&
      sessionShape(session) &&
      tokenless(session)
        ? pass('d2 session uses access cookie and returns tokenless session', safeDetail(session))
        : fail('d2 session uses access cookie and returns tokenless session', safeDetail(session))
    );

    const anonymousSession = await runSession({});
    checks.push(
      anonymousSession.status === 200 &&
      payloadData(anonymousSession).authenticated === false
        ? pass('d2 session without cookie returns authenticated false', safeDetail(anonymousSession))
        : fail('d2 session without cookie returns authenticated false', safeDetail(anonymousSession))
    );

    const invalidSession = await runSession({
      cookies: { [names.access]: INVALID_TOKEN }
    });
    checks.push(
      invalidSession.status === 401 &&
      clearCookiesValid(invalidSession, names) &&
      tokenless(invalidSession)
        ? pass('d2 invalid access cookie returns 401 and clears cookies', safeDetail(invalidSession))
        : fail('d2 invalid access cookie returns 401 and clears cookies', safeDetail(invalidSession))
    );

    const refreshNoCookie = await runController(AuthController.refreshToken, {
      method: 'POST',
      url: '/api/auth/refreshToken',
      body: { id_refresh_token: refresh1 }
    });
    checks.push(
      refreshNoCookie.status === 401 &&
      refreshNoCookie.cookies.length === 0
        ? pass('d2 refresh does not fall back to body without refresh cookie', safeDetail(refreshNoCookie))
        : fail('d2 refresh does not fall back to body without refresh cookie', safeDetail(refreshNoCookie))
    );

    const refresh = await runController(AuthController.refreshToken, {
      method: 'POST',
      url: '/api/auth/refreshToken',
      cookies: { [names.refresh]: refresh1 }
    });
    const access2 = cookieValue(refresh, names.access);
    const refresh2 = cookieValue(refresh, names.refresh);

    checks.push(
      refresh.status === 200 &&
      setCookiesValid(refresh, names) &&
      tokenless(refresh) &&
      refresh2 &&
      refresh2 !== refresh1
        ? pass('d2 refresh reads cookie, rotates and returns tokenless JSON', safeDetail(refresh))
        : fail('d2 refresh reads cookie, rotates and returns tokenless JSON', safeDetail(refresh))
    );

    const oldRefreshReuse = await runController(AuthController.refreshToken, {
      method: 'POST',
      url: '/api/auth/refreshToken',
      cookies: { [names.refresh]: refresh1 }
    });
    checks.push(
      oldRefreshReuse.status === 401
        ? pass('d2 old refresh cookie fails after rotation', safeDetail(oldRefreshReuse))
        : fail('d2 old refresh cookie fails after rotation', safeDetail(oldRefreshReuse))
    );

    const logout = await runLogout({
      cookies: { [names.access]: access2 }
    });
    checks.push(
      logout.status === 200 &&
      logout.authNextCalled &&
      clearCookiesValid(logout, names) &&
      tokenless(logout)
        ? pass('d2 logout uses access cookie, revokes session and clears cookies', safeDetail(logout))
        : fail('d2 logout uses access cookie, revokes session and clears cookies', safeDetail(logout))
    );

    const sessionAfterLogout = await runSession({
      cookies: { [names.access]: access2 }
    });
    checks.push(
      sessionAfterLogout.status === 401 &&
      clearCookiesValid(sessionAfterLogout, names) &&
      tokenless(sessionAfterLogout)
        ? pass('d2 session with old access cookie fails after logout', safeDetail(sessionAfterLogout))
        : fail('d2 session with old access cookie fails after logout', safeDetail(sessionAfterLogout))
    );

    const refreshAfterLogout = await runController(AuthController.refreshToken, {
      method: 'POST',
      url: '/api/auth/refreshToken',
      cookies: { [names.refresh]: refresh2 }
    });
    checks.push(
      refreshAfterLogout.status === 401
        ? pass('d2 refresh cookie fails after logout', safeDetail(refreshAfterLogout))
        : fail('d2 refresh cookie fails after logout', safeDetail(refreshAfterLogout))
    );
  });

  return checks;
}

async function validateLegacy() {
  const checks = [];
  const state = createState();
  const env = legacyEnv();

  await withEnvAndDao(env, state, async () => {
    const login = await runController(AuthController.login, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        param: '9993000777',
        pwd: 'not_printed',
        refresh: true
      }
    });
    const legacyToken = login.payload && login.payload.data ? login.payload.data.token : null;
    const legacyRefresh = login.payload && login.payload.data ? login.payload.data.refresh_token : null;

    checks.push(
      login.status === 200 &&
      legacyToken &&
      legacyRefresh &&
      login.cookies.length === 0
        ? pass('legacy login keeps token JSON contract and sets no D2 cookies', {
          status: login.status,
          hasToken: true,
          hasRefreshToken: true,
          cookieCount: login.cookies.length
        })
        : fail('legacy login keeps token JSON contract and sets no D2 cookies', safeDetail(login))
    );

    const session = await runSession({
      headers: { authorization: `Bearer ${legacyToken}` }
    });
    checks.push(
      session.status === 200 &&
      sessionShape(session) &&
      tokenless(session) &&
      session.cookies.length === 0
        ? pass('legacy session with Authorization works and stays tokenless', safeDetail(session))
        : fail('legacy session with Authorization works and stays tokenless', safeDetail(session))
    );

    const anonymousSession = await runSession({});
    checks.push(
      anonymousSession.status === 200 &&
      payloadData(anonymousSession).authenticated === false
        ? pass('legacy session without Authorization returns authenticated false', safeDetail(anonymousSession))
        : fail('legacy session without Authorization returns authenticated false', safeDetail(anonymousSession))
    );

    const refresh = await runController(AuthController.refreshToken, {
      method: 'POST',
      url: '/api/auth/refreshToken',
      body: { id_refresh_token: legacyRefresh }
    });
    const nextLegacyToken = refresh.payload && refresh.payload.data ? refresh.payload.data.token : null;
    const nextLegacyRefresh = refresh.payload && refresh.payload.data ? refresh.payload.data.refresh_token : null;
    checks.push(
      refresh.status === 200 &&
      nextLegacyToken &&
      nextLegacyRefresh &&
      refresh.cookies.length === 0
        ? pass('legacy refresh keeps body token contract and sets no cookies', {
          status: refresh.status,
          hasToken: true,
          hasRefreshToken: true,
          cookieCount: refresh.cookies.length
        })
        : fail('legacy refresh keeps body token contract and sets no cookies', safeDetail(refresh))
    );

    const logout = await runLogout({
      headers: { authorization: `Bearer ${nextLegacyToken}` }
    });
    checks.push(
      logout.status === 200 &&
      logout.authNextCalled &&
      logout.cookies.length === 0
        ? pass('legacy logout uses Authorization and sets no D2 clear cookies', safeDetail(logout))
        : fail('legacy logout uses Authorization and sets no D2 clear cookies', safeDetail(logout))
    );
  });

  return checks;
}

async function validate() {
  const checks = [
    ...(await validateD2()),
    ...(await validateLegacy())
  ];

  return {
    ok: checks.every((check) => check.ok),
    mode: 'in-memory integration',
    dbAccess: false,
    fixtures: 'in-memory fake auth/session/refresh state',
    cleanup: 'automatic process memory cleanup',
    checks
  };
}

async function up() {
  return {
    ok: true,
    mode: 'in-memory integration',
    dbAccess: false,
    fixturesCreated: false,
    persistentFixtures: false,
    cleanupRequired: false,
    message: 'No persistent fixtures are created. validate/full build in-memory state per run.'
  };
}

async function down() {
  return {
    ok: true,
    mode: 'in-memory integration',
    dbAccess: false,
    fixturesRemoved: true,
    remainingFixtures: 0,
    message: 'No persistent fixtures existed. Cleanup complete.'
  };
}

function status() {
  return {
    ok: true,
    script: 'd2-cookie-auth-integration',
    dbAccess: false,
    fixtures: 'in-memory only',
    cleanupRequired: false,
    productionLikeWriteBlockedByDesign: true,
    secretsPrinted: false,
    tokensPrinted: false,
    cookiesPrinted: false,
    commands: ['status', 'up', 'validate', 'down', 'full']
  };
}

async function full() {
  const steps = [];

  try {
    steps.push({ step: 'up', result: await up() });
    steps.push({ step: 'validate', result: await validate() });
  } finally {
    steps.push({ step: 'down', result: await down() });
  }

  return {
    ok: steps.every((step) => step.result && step.result.ok !== false),
    steps
  };
}

async function main() {
  const command = process.argv[2] || 'status';
  const commands = { status, up, validate, down, full };

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

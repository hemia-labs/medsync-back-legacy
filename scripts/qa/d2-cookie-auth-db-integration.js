'use strict';

require('../../src/config/env');

const { QueryTypes } = require('sequelize');
const sequelize = require('../../src/db/Sequelize.connection');
const SecurityConfig = require('../../src/config/security');
const AuthController = require('../../src/controller/mysql/auth.controller');
const AuthCookieConfig = require('../../src/config/authCookie.config');
const Token = require('../../src/auth/authenticate');
const { encript } = require('../../src/util/bcrypt');

const CREATED_BY = 'QA_D2_COOKIE_AUTH_DB_INTEGRATION';
const BUSINESS_ID = 'QA_D2_COOKIE_AUTH_DB_BUSINESS';
const QA_USER_AGENT = 'QA_D2_COOKIE_AUTH_DB_INTEGRATION';
const INVALID_TOKEN = 'qa.invalid.jwt.not_printed';

const USER = {
  id: 'QA_D2_COOKIE_AUTH_DB_USER',
  name: 'QA D2 Cookie Auth DB User',
  email: 'qa.d2.cookie.auth.db@example.test',
  phone: '9993000888',
  roleCode: 'admin'
};

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

function applyEnv(overrides) {
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
    AUTH_COOKIE_PATH: '/',
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

function runtimeEnv() {
  return process.env.APP_ENV || process.env.ENVIRONMENT || process.env.NODE_ENV || 'development';
}

async function dbIdentity() {
  try {
    const rows = await sequelize.query(
      'SELECT DATABASE() AS database_name, @@hostname AS database_host, @@port AS database_port',
      { type: QueryTypes.SELECT }
    );
    return rows[0] || {};
  } catch (error) {
    return {
      database_name: null,
      database_host: null,
      database_port: null,
      lookup_error: error.message
    };
  }
}

function looksProductionLikeDatabase(identity) {
  const value = `${identity.database_name || ''} ${identity.database_host || ''}`.toLowerCase();
  return /\b(prod|production|live)\b/.test(value) ||
    value.indexOf('prod_') !== -1 ||
    value.indexOf('_prod') !== -1;
}

async function assertNotProductionLike() {
  const identity = await dbIdentity();
  const productionLike = SecurityConfig.isProductionLike() || looksProductionLikeDatabase(identity);
  const override = process.env.ALLOW_D2_QA_PRODUCTION_LIKE === 'I_UNDERSTAND_RISK';

  if (productionLike && !override) {
    throw new Error('Abortado: ambiente production-like detectado. Requiere ALLOW_D2_QA_PRODUCTION_LIKE=I_UNDERSTAND_RISK.');
  }
}

function missingWriteEnv() {
  const missing = [];
  if (process.env.ALLOW_D2_QA_DB !== '1') missing.push('ALLOW_D2_QA_DB=1');
  if (process.env.ALLOW_QA_AUTH_FIXTURES !== 'true') missing.push('ALLOW_QA_AUTH_FIXTURES=true');
  if (!process.env.QA_AUTH_PASSWORD) missing.push('QA_AUTH_PASSWORD');
  if (!process.env.REFRESH_TOKEN_SECRET) missing.push('REFRESH_TOKEN_SECRET');
  if (process.env.REQUIRE_ACTIVE_SESSION !== 'true') missing.push('REQUIRE_ACTIVE_SESSION=true');
  return missing;
}

async function assertWriteAllowed(command) {
  await assertNotProductionLike();
  const missing = missingWriteEnv();
  if (missing.length > 0) {
    throw new Error(`${command} requiere variables QA: ${missing.join(', ')}.`);
  }
}

async function roleByCode(code) {
  const rows = await sequelize.query(
    `SELECT id_rol, code, desc_rol
       FROM rol
      WHERE code COLLATE utf8mb4_unicode_ci = :code COLLATE utf8mb4_unicode_ci
        AND active = 1
      LIMIT 1`,
    { replacements: { code }, type: QueryTypes.SELECT }
  );
  return rows[0] || null;
}

async function permissionCount(idRol) {
  if (!idRol) {
    return 0;
  }

  const rows = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM permission_rol pr
       INNER JOIN cat_permission cp
               ON cp.id_cat_permission = pr.id_cat_permission
              AND cp.active = 1
      WHERE pr.id_rol = :idRol
        AND pr.active = 1`,
    { replacements: { idRol }, type: QueryTypes.SELECT }
  );
  return Number(rows[0] ? rows[0].total : 0);
}

async function ensureBusiness(transaction) {
  await sequelize.query(
    `INSERT INTO business (
        id_business, name, legal_name, slug, email, phone, address, status, plan,
        active, subscription_status, current_period_starts_at, created_at, created_by
      ) VALUES (
        :id, 'QA D2 Cookie Auth DB Clinic', 'QA D2 Cookie Auth DB Clinic',
        'qa-d2-cookie-auth-db-clinic', 'qa.d2.cookie.auth.db.business@example.test',
        '9993000880', 'QA fixture local/dev', 'active', 'enterprise',
        1, 'active', NOW(), NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        legal_name = VALUES(legal_name),
        email = VALUES(email),
        phone = VALUES(phone),
        status = 'active',
        plan = 'enterprise',
        active = 1,
        subscription_status = 'active',
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: { id: BUSINESS_ID, createdBy: CREATED_BY },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureLogin(role, passwordHash, transaction) {
  await sequelize.query(
    `INSERT INTO login (
        id_login, id_business, id_rol, name, email, telephone, password, locked,
        active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :id, :businessId, :roleId, :name, :email, :phone, :password, 0,
        1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_rol = VALUES(id_rol),
        name = VALUES(name),
        email = VALUES(email),
        telephone = VALUES(telephone),
        password = VALUES(password),
        locked = 0,
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        id: USER.id,
        businessId: BUSINESS_ID,
        roleId: role.id_rol,
        name: USER.name,
        email: USER.email,
        phone: USER.phone,
        password: passwordHash,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function removeFixtures(transaction = null) {
  await sequelize.query(
    `DELETE FROM refresh_token
      WHERE id_login COLLATE utf8mb4_unicode_ci = :idLogin COLLATE utf8mb4_unicode_ci`,
    { replacements: { idLogin: USER.id }, type: QueryTypes.DELETE, transaction }
  );
  await sequelize.query(
    `DELETE FROM \`session\`
      WHERE id_login COLLATE utf8mb4_unicode_ci = :idLogin COLLATE utf8mb4_unicode_ci`,
    { replacements: { idLogin: USER.id }, type: QueryTypes.DELETE, transaction }
  );
  await sequelize.query(
    `DELETE FROM login
      WHERE id_login COLLATE utf8mb4_unicode_ci = :idLogin COLLATE utf8mb4_unicode_ci
         OR telephone COLLATE utf8mb4_unicode_ci = :phone COLLATE utf8mb4_unicode_ci
         OR email COLLATE utf8mb4_unicode_ci = :email COLLATE utf8mb4_unicode_ci`,
    {
      replacements: {
        idLogin: USER.id,
        phone: USER.phone,
        email: USER.email
      },
      type: QueryTypes.DELETE,
      transaction
    }
  );
  await sequelize.query(
    `DELETE FROM business
      WHERE id_business COLLATE utf8mb4_unicode_ci = :businessId COLLATE utf8mb4_unicode_ci`,
    { replacements: { businessId: BUSINESS_ID }, type: QueryTypes.DELETE, transaction }
  );
}

async function fixtureStatus() {
  const [users, sessions, refreshTokens, business] = await Promise.all([
    sequelize.query(
      `SELECT id_login, telephone, active
         FROM login
        WHERE id_login COLLATE utf8mb4_unicode_ci = :idLogin COLLATE utf8mb4_unicode_ci
           OR telephone COLLATE utf8mb4_unicode_ci = :phone COLLATE utf8mb4_unicode_ci`,
      { replacements: { idLogin: USER.id, phone: USER.phone }, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN active = 1 AND \`last\` = 1 THEN 1 ELSE 0 END) AS active_count
         FROM \`session\`
        WHERE id_login COLLATE utf8mb4_unicode_ci = :idLogin COLLATE utf8mb4_unicode_ci`,
      { replacements: { idLogin: USER.id }, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN \`last\` = 1 AND revoked_at IS NULL THEN 1 ELSE 0 END) AS active_count
         FROM refresh_token
        WHERE id_login COLLATE utf8mb4_unicode_ci = :idLogin COLLATE utf8mb4_unicode_ci`,
      { replacements: { idLogin: USER.id }, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT id_business, status, active, subscription_status, plan
         FROM business
        WHERE id_business COLLATE utf8mb4_unicode_ci = :businessId COLLATE utf8mb4_unicode_ci`,
      { replacements: { businessId: BUSINESS_ID }, type: QueryTypes.SELECT }
    )
  ]);

  return {
    users: users.map((row) => ({
      id_login: row.id_login,
      telephone: row.telephone,
      active: row.active
    })),
    business: business.map((row) => ({
      id_business: row.id_business,
      status: row.status,
      active: row.active,
      subscription_status: row.subscription_status,
      plan: row.plan
    })),
    sessionCount: Number(sessions[0] ? sessions[0].total || 0 : 0),
    activeSessionCount: Number(sessions[0] ? sessions[0].active_count || 0 : 0),
    refreshTokenCount: Number(refreshTokens[0] ? refreshTokens[0].total || 0 : 0),
    activeRefreshTokenCount: Number(refreshTokens[0] ? refreshTokens[0].active_count || 0 : 0)
  };
}

async function status() {
  const identity = await dbIdentity();
  const role = await roleByCode(USER.roleCode);

  return {
    ok: true,
    script: 'd2-cookie-auth-db-integration',
    mode: 'db integration',
    dbAccess: true,
    runtimeEnv: runtimeEnv(),
    productionLike: SecurityConfig.isProductionLike(),
    database: {
      name: identity.database_name || null,
      host: identity.database_host || null,
      port: identity.database_port || null,
      productionLikeNameOrHost: looksProductionLikeDatabase(identity)
    },
    env: {
      allowD2QaDb: process.env.ALLOW_D2_QA_DB === '1',
      allowQaFixtures: process.env.ALLOW_QA_AUTH_FIXTURES === 'true',
      allowProductionLikeOverride: process.env.ALLOW_D2_QA_PRODUCTION_LIKE === 'I_UNDERSTAND_RISK',
      hasQaPassword: Boolean(process.env.QA_AUTH_PASSWORD),
      requireActiveSession: SecurityConfig.isActiveSessionRequired(),
      refreshSecretConfigured: SecurityConfig.getRefreshTokenSecretState().configured,
      refreshSecretWeak: SecurityConfig.getRefreshTokenSecretState().isWeak
    },
    requiredEnv: [
      'ALLOW_D2_QA_DB=1',
      'ALLOW_QA_AUTH_FIXTURES=true',
      'QA_AUTH_PASSWORD',
      'REFRESH_TOKEN_SECRET',
      'REQUIRE_ACTIVE_SESSION=true'
    ],
    role: {
      required: USER.roleCode,
      found: Boolean(role),
      permissionCount: role ? await permissionCount(role.id_rol) : 0
    },
    fixtures: await fixtureStatus(),
    commands: ['status', 'up', 'validate', 'down', 'full'],
    secretsPrinted: false,
    tokensPrinted: false,
    cookiesPrinted: false
  };
}

async function up() {
  await assertWriteAllowed('up');
  const role = await roleByCode(USER.roleCode);
  if (!role) {
    throw new Error('No se encontro rol activo admin para fixture D2 DB.');
  }

  const passwordHash = await encript(process.env.QA_AUTH_PASSWORD);
  const transaction = await sequelize.transaction();

  try {
    await removeFixtures(transaction);
    await ensureBusiness(transaction);
    await ensureLogin(role, passwordHash, transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return {
    ok: true,
    createdBy: CREATED_BY,
    fixture: {
      id_login: USER.id,
      phone: USER.phone,
      email: USER.email,
      businessId: BUSINESS_ID,
      roleCode: USER.roleCode
    },
    cleanupCommand: 'node scripts/qa/d2-cookie-auth-db-integration.js down'
  };
}

async function down() {
  await assertWriteAllowed('down');
  const transaction = await sequelize.transaction();

  try {
    await removeFixtures(transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  const remaining = await fixtureStatus();

  return {
    ok: true,
    fixturesRemoved: true,
    remainingFixtureUsers: remaining.users.length,
    remainingFixtureBusinesses: remaining.business.length,
    remainingSessions: remaining.sessionCount,
    remainingRefreshTokens: remaining.refreshTokenCount
  };
}

function createReq(options) {
  const headers = Object.assign({}, options.headers || {});
  return {
    body: Object.assign({}, options.body || {}),
    headers,
    cookies: Object.assign({}, options.cookies || {}),
    ip: '127.0.0.1',
    method: options.method || 'GET',
    url: options.url || '/qa/d2/db-integration',
    originalUrl: options.url || '/qa/d2/db-integration',
    get(name) {
      const key = String(name || '').toLowerCase();
      if (key === 'user-agent') {
        return QA_USER_AGENT;
      }
      return headers[key] || headers[name] || null;
    }
  };
}

function createRes(done) {
  return {
    statusCode: null,
    payload: null,
    cookies: [],
    headers: {},
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
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
    data.user.id_login &&
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

async function withRuntimeEnv(env, fn) {
  const snapshot = snapshotEnv();
  const originalInfo = console.info;

  try {
    applyEnv(env);
    console.info = function noop() {};
    return await fn();
  } finally {
    console.info = originalInfo;
    restoreEnv(snapshot);
  }
}

function cookieNamesFor(env) {
  return AuthCookieConfig.getCookieNames({ env: Object.assign({}, process.env, env) });
}

async function validateD2() {
  const checks = [];
  const env = baseD2Env();
  const names = cookieNamesFor(env);

  await withRuntimeEnv(env, async () => {
    const login = await runController(AuthController.login, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        param: USER.phone,
        pwd: process.env.QA_AUTH_PASSWORD,
        refresh: false
      }
    });
    const access1 = cookieValue(login, names.access);
    const refresh1 = cookieValue(login, names.refresh);

    checks.push(
      login.status === 200 &&
      setCookiesValid(login, names) &&
      tokenless(login)
        ? pass('d2 DB login sets access/refresh HttpOnly session cookies and tokenless JSON', safeDetail(login))
        : fail('d2 DB login sets access/refresh HttpOnly session cookies and tokenless JSON', safeDetail(login))
    );

    const session = await runSession({
      cookies: { [names.access]: access1 }
    });
    checks.push(
      session.status === 200 &&
      sessionShape(session) &&
      tokenless(session)
        ? pass('d2 DB session uses access cookie and returns tokenless session', safeDetail(session))
        : fail('d2 DB session uses access cookie and returns tokenless session', safeDetail(session))
    );

    const anonymousSession = await runSession({});
    checks.push(
      anonymousSession.status === 200 &&
      payloadData(anonymousSession).authenticated === false
        ? pass('d2 DB session without cookie returns authenticated false', safeDetail(anonymousSession))
        : fail('d2 DB session without cookie returns authenticated false', safeDetail(anonymousSession))
    );

    const invalidSession = await runSession({
      cookies: { [names.access]: INVALID_TOKEN }
    });
    checks.push(
      invalidSession.status === 401 &&
      clearCookiesValid(invalidSession, names) &&
      tokenless(invalidSession)
        ? pass('d2 DB invalid access cookie returns 401 and clears D2 cookies', safeDetail(invalidSession))
        : fail('d2 DB invalid access cookie returns 401 and clears D2 cookies', safeDetail(invalidSession))
    );

    const refreshNoCookie = await runController(AuthController.refreshToken, {
      method: 'POST',
      url: '/api/auth/refreshToken',
      body: { id_refresh_token: refresh1 }
    });
    checks.push(
      refreshNoCookie.status === 401 &&
      refreshNoCookie.cookies.length === 0
        ? pass('d2 DB refresh ignores body fallback without refresh cookie', safeDetail(refreshNoCookie))
        : fail('d2 DB refresh ignores body fallback without refresh cookie', safeDetail(refreshNoCookie))
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
        ? pass('d2 DB refresh reads cookie, rotates v2 token and returns tokenless JSON', safeDetail(refresh))
        : fail('d2 DB refresh reads cookie, rotates v2 token and returns tokenless JSON', safeDetail(refresh))
    );

    const logout = await runLogout({
      cookies: { [names.access]: access2 }
    });
    checks.push(
      logout.status === 200 &&
      logout.authNextCalled &&
      clearCookiesValid(logout, names) &&
      tokenless(logout)
        ? pass('d2 DB logout uses access cookie, revokes server artifacts and clears cookies', safeDetail(logout))
        : fail('d2 DB logout uses access cookie, revokes server artifacts and clears cookies', safeDetail(logout))
    );

    const sessionAfterLogout = await runSession({
      cookies: { [names.access]: access2 }
    });
    checks.push(
      sessionAfterLogout.status === 401 &&
      clearCookiesValid(sessionAfterLogout, names) &&
      tokenless(sessionAfterLogout)
        ? pass('d2 DB old access cookie fails after logout', safeDetail(sessionAfterLogout))
        : fail('d2 DB old access cookie fails after logout', safeDetail(sessionAfterLogout))
    );

    const refreshAfterLogout = await runController(AuthController.refreshToken, {
      method: 'POST',
      url: '/api/auth/refreshToken',
      cookies: { [names.refresh]: refresh2 }
    });
    checks.push(
      refreshAfterLogout.status === 401
        ? pass('d2 DB refresh cookie fails after logout', safeDetail(refreshAfterLogout))
        : fail('d2 DB refresh cookie fails after logout', safeDetail(refreshAfterLogout))
    );

    await up();

    const reuseLogin = await runController(AuthController.login, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        param: USER.phone,
        pwd: process.env.QA_AUTH_PASSWORD,
        refresh: false
      }
    });
    const oldRefresh = cookieValue(reuseLogin, names.refresh);

    const reuseRefresh = await runController(AuthController.refreshToken, {
      method: 'POST',
      url: '/api/auth/refreshToken',
      cookies: { [names.refresh]: oldRefresh }
    });
    const rotatedRefresh = cookieValue(reuseRefresh, names.refresh);

    const oldRefreshReuse = await runController(AuthController.refreshToken, {
      method: 'POST',
      url: '/api/auth/refreshToken',
      cookies: { [names.refresh]: oldRefresh }
    });

    checks.push(
      reuseLogin.status === 200 &&
      reuseRefresh.status === 200 &&
      rotatedRefresh &&
      rotatedRefresh !== oldRefresh &&
      oldRefreshReuse.status === 401
        ? pass('d2 DB old refresh cookie fails after rotation/reuse detection', {
          loginStatus: reuseLogin.status,
          refreshStatus: reuseRefresh.status,
          oldRefreshReuseStatus: oldRefreshReuse.status,
          cookiesPrinted: false
        })
        : fail('d2 DB old refresh cookie fails after rotation/reuse detection', {
          login: safeDetail(reuseLogin),
          refresh: safeDetail(reuseRefresh),
          oldRefreshReuse: safeDetail(oldRefreshReuse)
        })
    );
  });

  return checks;
}

async function validateLegacy() {
  const checks = [];
  const env = legacyEnv();

  await withRuntimeEnv(env, async () => {
    const login = await runController(AuthController.login, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        param: USER.phone,
        pwd: process.env.QA_AUTH_PASSWORD,
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
        ? pass('legacy DB login keeps token JSON contract and sets no D2 cookies', {
          status: login.status,
          hasToken: true,
          hasRefreshToken: true,
          cookieCount: login.cookies.length
        })
        : fail('legacy DB login keeps token JSON contract and sets no D2 cookies', safeDetail(login))
    );

    const session = await runSession({
      headers: { authorization: `Bearer ${legacyToken}` }
    });
    checks.push(
      session.status === 200 &&
      sessionShape(session) &&
      tokenless(session) &&
      session.cookies.length === 0
        ? pass('legacy DB session with Authorization works and stays tokenless', safeDetail(session))
        : fail('legacy DB session with Authorization works and stays tokenless', safeDetail(session))
    );

    const anonymousSession = await runSession({});
    checks.push(
      anonymousSession.status === 200 &&
      payloadData(anonymousSession).authenticated === false
        ? pass('legacy DB session without Authorization returns authenticated false', safeDetail(anonymousSession))
        : fail('legacy DB session without Authorization returns authenticated false', safeDetail(anonymousSession))
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
        ? pass('legacy DB refresh uses body contract and sets no D2 cookies', {
          status: refresh.status,
          hasToken: true,
          hasRefreshToken: true,
          cookieCount: refresh.cookies.length
        })
        : fail('legacy DB refresh uses body contract and sets no D2 cookies', safeDetail(refresh))
    );

    const logout = await runLogout({
      headers: { authorization: `Bearer ${nextLegacyToken}` }
    });
    checks.push(
      logout.status === 200 &&
      logout.authNextCalled &&
      logout.cookies.length === 0
        ? pass('legacy DB logout uses Authorization and sets no D2 clear cookies', safeDetail(logout))
        : fail('legacy DB logout uses Authorization and sets no D2 clear cookies', safeDetail(logout))
    );
  });

  return checks;
}

async function validate() {
  const checks = [];
  const cleanup = {
    attempted: false,
    ok: false,
    result: null,
    error: null
  };
  let phase = 'setup';

  try {
    phase = 'up:d2';
    await up();
    phase = 'validate:d2';
    checks.push(...await validateD2());
    phase = 'up:legacy';
    await up();
    phase = 'validate:legacy';
    checks.push(...await validateLegacy());
  } catch (error) {
    checks.push(fail(`d2 DB integration threw during ${phase}`, {
      message: error.message
    }));
  } finally {
    cleanup.attempted = true;
    try {
      cleanup.result = await down();
      cleanup.ok = cleanup.result && cleanup.result.ok === true;
    } catch (error) {
      cleanup.error = error.message;
    }
  }

  return {
    ok: checks.length > 0 && checks.every((check) => check.ok) && cleanup.ok,
    mode: 'db integration',
    dbAccess: true,
    fixtures: {
      type: 'fictitious DB fixtures',
      userId: USER.id,
      businessId: BUSINESS_ID,
      phone: USER.phone,
      cleanup
    },
    logs: {
      secretsPrinted: false,
      passwordsPrinted: false,
      otpPrinted: false,
      tokensPrinted: false,
      cookiesPrinted: false,
      fullFingerprintsPrinted: false
    },
    checks
  };
}

async function full() {
  const steps = [];

  async function runStep(step, fn) {
    try {
      steps.push({ step, result: await fn() });
    } catch (error) {
      steps.push({ step, result: { ok: false, error: error.message } });
    }
  }

  await runStep('status-before', status);
  await runStep('validate', validate);
  await runStep('down', down);
  await runStep('status-after', status);

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

main()
  .catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error.message
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });

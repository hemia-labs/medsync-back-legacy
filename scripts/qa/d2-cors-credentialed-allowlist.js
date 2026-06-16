'use strict';

require('../../src/config/env');

const SecurityConfig = require('../../src/config/security');
const { corsCredentialedAllowlist } = require('../../src/middleware/corsCredentialed.middleware');

const ALLOWED_ORIGIN = 'https://app.example.test';
const LOCAL_ALLOWED_ORIGIN = 'http://localhost:8080';
const BLOCKED_ORIGIN = 'https://evil.example.test';
const QA_SECRET = 'QA_D2_4_SECRET_0123456789_abcdefghijklmnopqrstuvwxyz';

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
  'CSRF_ORIGIN_CHECK_ENABLED',
  'CSRF_ALLOWED_ORIGINS',
  'CORS_CREDENTIALS',
  'CORS_ALLOWED_ORIGINS',
  'CORS_ORIGIN',
  'CORS_ALLOWED_HEADERS',
  'CORS_ALLOWED_METHODS',
  'CORS_MAX_AGE_SECONDS',
  'JWT_SECRET',
  'REFRESH_TOKEN_SECRET',
  'PASSWORD_RESET_CODE_SECRET',
  'REQUIRE_ACTIVE_SESSION',
  'REFRESH_TOKEN_ROTATION_ENABLED',
  'NODE_ENV',
  'APP_ENV',
  'ENVIRONMENT'
];

const silentLogger = {
  info() {},
  warn() {}
};

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

async function withEnv(env, fn) {
  const snapshot = snapshotEnv();
  try {
    setEnv(env);
    return await fn();
  } finally {
    restoreEnv(snapshot);
  }
}

function baseSecurityEnv(overrides) {
  return Object.assign({
    NODE_ENV: 'development',
    APP_ENV: '',
    ENVIRONMENT: '',
    REQUIRE_ACTIVE_SESSION: 'true',
    REFRESH_TOKEN_ROTATION_ENABLED: 'true',
    JWT_SECRET: QA_SECRET,
    REFRESH_TOKEN_SECRET: `${QA_SECRET}_refresh`,
    PASSWORD_RESET_CODE_SECRET: `${QA_SECRET}_password_reset`,
    AUTH_COOKIE_MODE: 'legacy',
    BROWSER_AUTH_TRANSPORT: 'authorization',
    AUTH_COOKIE_SECURE: 'true',
    AUTH_COOKIE_SAMESITE: 'Lax',
    CSRF_ENABLED: 'false',
    CORS_CREDENTIALS: 'false',
    CORS_ALLOWED_ORIGINS: '*'
  }, overrides || {});
}

function d2Env(overrides) {
  return baseSecurityEnv(Object.assign({
    AUTH_COOKIE_MODE: 'd2',
    BROWSER_AUTH_TRANSPORT: 'cookie',
    AUTH_COOKIE_MAX_AGE_MODE: 'session',
    AUTH_COOKIE_ACCESS_NAME: '__Host-medsync_at',
    AUTH_COOKIE_REFRESH_NAME: '__Host-medsync_rt',
    AUTH_CSRF_COOKIE_NAME: '__Host-medsync_csrf',
    AUTH_COOKIE_DOMAIN: '',
    AUTH_COOKIE_PATH: '/',
    CSRF_ENABLED: 'true',
    CSRF_TOKEN_SECRET: QA_SECRET,
    CSRF_HEADER_NAME: 'X-CSRF-Token',
    CSRF_ORIGIN_CHECK_ENABLED: 'true',
    CSRF_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    CORS_CREDENTIALS: 'true',
    CORS_ALLOWED_ORIGINS: `${ALLOWED_ORIGIN},${LOCAL_ALLOWED_ORIGIN}`,
    CORS_ALLOWED_HEADERS: 'Content-Type, Accept, X-CSRF-Token, X-Requested-With, Authorization',
    CORS_ALLOWED_METHODS: 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  }, overrides || {}));
}

function legacyEnv(overrides) {
  return baseSecurityEnv(Object.assign({
    AUTH_COOKIE_MODE: 'legacy',
    BROWSER_AUTH_TRANSPORT: 'authorization',
    CSRF_ENABLED: 'false',
    CORS_CREDENTIALS: 'false',
    CORS_ALLOWED_ORIGINS: '*'
  }, overrides || {}));
}

function createReq(options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (options.origin) {
    headers.origin = options.origin;
  }

  return {
    method: options.method || 'GET',
    headers,
    url: options.url || '/qa/d2/cors',
    originalUrl: options.url || '/qa/d2/cors'
  };
}

function createRes() {
  return {
    statusCode: null,
    headers: {},
    payload: undefined,
    header(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    }
  };
}

function runCors(options = {}) {
  const req = createReq(options);
  const res = createRes();
  const middleware = corsCredentialedAllowlist();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  return {
    status: res.statusCode || (nextCalled ? 200 : null),
    headers: res.headers,
    nextCalled
  };
}

function csvIncludes(value, expected) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .includes(String(expected).toLowerCase());
}

function pass(name, detail) {
  return { name, ok: true, detail: detail || null };
}

function fail(name, detail) {
  return { name, ok: false, detail: detail || null };
}

async function expectStartupInvalid(name, env, expectedText) {
  return withEnv(env, async () => {
    try {
      SecurityConfig.validateStartupConfig(silentLogger);
    } catch (error) {
      if (String(error.message).toLowerCase().includes(String(expectedText).toLowerCase())) {
        return pass(name, { matched: expectedText });
      }

      return fail(name, {
        expected: expectedText,
        error: error.message
      });
    }

    return fail(name, { expected: expectedText, error: 'Startup validation passed unexpectedly' });
  });
}

async function validate() {
  const checks = [];

  await withEnv(d2Env(), async () => {
    const allowed = runCors({ method: 'OPTIONS', origin: ALLOWED_ORIGIN });
    const allowedHeaders = allowed.headers['access-control-allow-headers'];
    const allowedMethods = allowed.headers['access-control-allow-methods'];

    checks.push(
      allowed.status === 204 &&
      allowed.headers['access-control-allow-origin'] === ALLOWED_ORIGIN
        ? pass('Allowed origin receives exact Access-Control-Allow-Origin', {
          status: allowed.status,
          origin: allowed.headers['access-control-allow-origin']
        })
        : fail('Allowed origin receives exact Access-Control-Allow-Origin', allowed)
    );

    checks.push(
      allowed.headers['access-control-allow-credentials'] === 'true'
        ? pass('Allowed origin receives credentialed CORS', { credentials: true })
        : fail('Allowed origin receives credentialed CORS', allowed)
    );

    checks.push(
      csvIncludes(allowed.headers.vary, 'Origin')
        ? pass('Allowed origin receives Vary Origin', { vary: allowed.headers.vary })
        : fail('Allowed origin receives Vary Origin', allowed)
    );

    checks.push(
      csvIncludes(allowedHeaders, 'X-CSRF-Token')
        ? pass('Preflight allows X-CSRF-Token', { allowedHeaders })
        : fail('Preflight allows X-CSRF-Token', { allowedHeaders })
    );

    const expectedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
    const missingMethods = expectedMethods.filter((method) => !csvIncludes(allowedMethods, method));
    checks.push(
      missingMethods.length === 0
        ? pass('Preflight allows expected methods', { allowedMethods })
        : fail('Preflight allows expected methods', { allowedMethods, missingMethods })
    );

    checks.push(
      csvIncludes(allowedHeaders, 'Authorization')
        ? pass('Legacy Authorization header remains allowed', {
          note: 'Browser D2 does not depend on Authorization.'
        })
        : fail('Legacy Authorization header remains allowed', { allowedHeaders })
    );

    const blockedPreflight = runCors({ method: 'OPTIONS', origin: BLOCKED_ORIGIN });
    checks.push(
      blockedPreflight.status === 403 &&
      !blockedPreflight.headers['access-control-allow-origin'] &&
      !blockedPreflight.headers['access-control-allow-credentials']
        ? pass('Blocked origin preflight is rejected without reflect/credentials', {
          status: blockedPreflight.status
        })
        : fail('Blocked origin preflight is rejected without reflect/credentials', blockedPreflight)
    );

    const blockedGet = runCors({ method: 'GET', origin: BLOCKED_ORIGIN });
    checks.push(
      blockedGet.status === 200 &&
      blockedGet.nextCalled &&
      !blockedGet.headers['access-control-allow-origin'] &&
      !blockedGet.headers['access-control-allow-credentials']
        ? pass('Blocked origin request reaches app without CORS allow headers', {
          status: blockedGet.status,
          nextCalled: blockedGet.nextCalled
        })
        : fail('Blocked origin request reaches app without CORS allow headers', blockedGet)
    );
  });

  await withEnv(legacyEnv(), async () => {
    const noOrigin = runCors({ method: 'GET' });
    const noOriginOptions = runCors({ method: 'OPTIONS' });

    checks.push(
      noOrigin.status === 200 &&
      noOrigin.nextCalled &&
      !noOrigin.headers['access-control-allow-origin'] &&
      !noOrigin.headers['access-control-allow-credentials']
        ? pass('Legacy/default request without Origin is not broken', {
          status: noOrigin.status,
          nextCalled: noOrigin.nextCalled
        })
        : fail('Legacy/default request without Origin is not broken', noOrigin)
    );

    checks.push(
      noOriginOptions.status === 204 &&
      !noOriginOptions.headers['access-control-allow-origin'] &&
      !noOriginOptions.headers['access-control-allow-credentials']
        ? pass('OPTIONS without Origin returns 204 without wildcard/credentials', {
          status: noOriginOptions.status
        })
        : fail('OPTIONS without Origin returns 204 without wildcard/credentials', noOriginOptions)
    );
  });

  checks.push(await expectStartupInvalid(
    'Wildcard with credentials fails startup validation',
    d2Env({ CORS_ALLOWED_ORIGINS: '*' }),
    'Wildcard CORS'
  ));

  checks.push(await expectStartupInvalid(
    'D2 active without credentials fails startup validation',
    d2Env({ CORS_CREDENTIALS: 'false' }),
    'CORS_CREDENTIALS'
  ));

  checks.push(await expectStartupInvalid(
    'D2 active without allowlist fails startup validation',
    d2Env({ CORS_ALLOWED_ORIGINS: '', CORS_ORIGIN: '' }),
    'CORS_ALLOWED_ORIGINS'
  ));

  checks.push(await expectStartupInvalid(
    'Production-like wildcard fails startup validation',
    baseSecurityEnv({ NODE_ENV: 'production', CORS_CREDENTIALS: 'false', CORS_ALLOWED_ORIGINS: '*' }),
    'allows any origin'
  ));

  checks.push(await expectStartupInvalid(
    'Production-like non-local http origin fails startup validation',
    baseSecurityEnv({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'http://example.test' }),
    'non-local http'
  ));

  checks.push(await expectStartupInvalid(
    'D2 preflight without X-CSRF-Token fails startup validation',
    d2Env({ CORS_ALLOWED_HEADERS: 'Content-Type, Accept, X-Requested-With, Authorization' }),
    'X-CSRF-Token'
  ));

  return {
    ok: checks.every((check) => check.ok),
    mode: 'd2 cors credentialed allowlist',
    dbAccess: false,
    fixtures: 'in-memory/mock only',
    cleanupRequired: false,
    secretsPrinted: false,
    passwordsPrinted: false,
    otpPrinted: false,
    authTokensPrinted: false,
    cookiesPrinted: false,
    checks
  };
}

function status() {
  const config = SecurityConfig.getCorsRuntimeConfig();

  return {
    ok: true,
    script: 'd2-cors-credentialed-allowlist',
    dbAccess: false,
    fixtures: 'in-memory/mock only',
    cleanupRequired: false,
    commands: ['status', 'validate', 'full'],
    requiredEnvForD2: [
      'CORS_CREDENTIALS=true',
      'CORS_ALLOWED_ORIGINS=<exact frontend origins>',
      'CORS_ALLOWED_HEADERS includes X-CSRF-Token',
      'CORS_ALLOWED_METHODS includes GET, POST, PUT, PATCH, DELETE, OPTIONS'
    ],
    currentSafeSummary: {
      credentials: config.credentials,
      allowAnyOrigin: config.allowAnyOrigin,
      originCount: config.origins.length,
      allowedHeaders: config.allowedHeaders,
      allowedMethods: config.allowedMethods,
      maxAgeConfigured: config.maxAgeSeconds !== null
    },
    secretsPrinted: false,
    passwordsPrinted: false,
    otpPrinted: false,
    authTokensPrinted: false,
    cookiesPrinted: false
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

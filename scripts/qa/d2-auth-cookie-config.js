'use strict';

require('../../src/config/env');

const AuthCookieConfig = require('../../src/config/authCookie.config');

function safeSummary(env) {
  const config = AuthCookieConfig.getAuthCookieConfig({ env });
  const validation = AuthCookieConfig.validateAuthCookieConfig(config);
  const summary = AuthCookieConfig.getSafeAuthCookieConfigSummary(config);

  return {
    summary,
    validation
  };
}

function pass(name, detail) {
  return {
    name,
    ok: true,
    detail: detail || null
  };
}

function fail(name, detail) {
  return {
    name,
    ok: false,
    detail: detail || null
  };
}

function expectInvalid(name, env, expectedText) {
  const result = safeSummary(env);
  const joined = result.validation.errors.join(' | ');

  if (!result.validation.ok && joined.indexOf(expectedText) !== -1) {
    return pass(name, { matched: expectedText });
  }

  return fail(name, {
    expected: expectedText,
    errors: result.validation.errors
  });
}

function expectValid(name, env) {
  const result = safeSummary(env);

  if (result.validation.ok) {
    return pass(name, {
      secure: result.summary.secure,
      sameSite: result.summary.sameSite,
      cookieAuthEnabled: result.summary.cookieAuthEnabled,
      cookieMaxAgeMode: result.summary.cookieMaxAgeMode,
      cookieMaxAgeEnabled: result.summary.cookieMaxAgeEnabled,
      domainConfigured: result.summary.domainConfigured,
      corsCredentials: result.summary.corsCredentials,
      corsAllowAnyOrigin: result.summary.corsAllowAnyOrigin
    });
  }

  return fail(name, { errors: result.validation.errors });
}

function hasOption(options, key) {
  return Object.prototype.hasOwnProperty.call(options, key);
}

function expectSessionCookieOptions(name, env) {
  const config = AuthCookieConfig.getAuthCookieConfig({ env });
  const access = AuthCookieConfig.getAccessCookieOptions(config);
  const refresh = AuthCookieConfig.getRefreshCookieOptions(config);
  const csrf = AuthCookieConfig.getCsrfCookieOptions(config);
  const clearAccess = AuthCookieConfig.getClearAccessCookieOptions(config);
  const clearRefresh = AuthCookieConfig.getClearRefreshCookieOptions(config);
  const clearCsrf = AuthCookieConfig.getClearCsrfCookieOptions(config);
  const setOptionsOk = access.httpOnly === true &&
    refresh.httpOnly === true &&
    csrf.httpOnly === false &&
    access.secure === true &&
    refresh.secure === true &&
    csrf.secure === true &&
    access.sameSite === 'lax' &&
    refresh.sameSite === 'lax' &&
    csrf.sameSite === 'lax' &&
    access.path === '/' &&
    refresh.path === '/' &&
    csrf.path === '/';
  const sessionOptionsOk = !hasOption(access, 'maxAge') &&
    !hasOption(refresh, 'maxAge') &&
    !hasOption(csrf, 'maxAge') &&
    !hasOption(access, 'expires') &&
    !hasOption(refresh, 'expires') &&
    !hasOption(csrf, 'expires');
  const clearOptionsOk = clearAccess.httpOnly === access.httpOnly &&
    clearRefresh.httpOnly === refresh.httpOnly &&
    clearCsrf.httpOnly === csrf.httpOnly &&
    clearAccess.secure === access.secure &&
    clearRefresh.secure === refresh.secure &&
    clearCsrf.secure === csrf.secure &&
    clearAccess.sameSite === access.sameSite &&
    clearRefresh.sameSite === refresh.sameSite &&
    clearCsrf.sameSite === csrf.sameSite &&
    clearAccess.path === access.path &&
    clearRefresh.path === refresh.path &&
    clearCsrf.path === csrf.path &&
    clearAccess.maxAge === 0 &&
    clearRefresh.maxAge === 0 &&
    clearCsrf.maxAge === 0;

  if (setOptionsOk && sessionOptionsOk && clearOptionsOk) {
    return pass(name, {
      cookieMaxAgeMode: config.maxAgeMode,
      accessHttpOnly: access.httpOnly,
      refreshHttpOnly: refresh.httpOnly,
      csrfHttpOnly: csrf.httpOnly,
      secure: access.secure,
      sameSite: access.sameSite,
      path: access.path,
      accessMaxAgeConfigured: hasOption(access, 'maxAge'),
      refreshMaxAgeConfigured: hasOption(refresh, 'maxAge'),
      csrfMaxAgeConfigured: hasOption(csrf, 'maxAge'),
      accessExpiresConfigured: hasOption(access, 'expires'),
      refreshExpiresConfigured: hasOption(refresh, 'expires'),
      csrfExpiresConfigured: hasOption(csrf, 'expires'),
      clearMaxAge: clearAccess.maxAge
    });
  }

  return fail(name, {
    setOptionsOk,
    sessionOptionsOk,
    clearOptionsOk
  });
}

function expectTtlCookieOptions(name, env) {
  const config = AuthCookieConfig.getAuthCookieConfig({ env });
  const access = AuthCookieConfig.getAccessCookieOptions(config);
  const refresh = AuthCookieConfig.getRefreshCookieOptions(config);
  const csrf = AuthCookieConfig.getCsrfCookieOptions(config);
  const clearAccess = AuthCookieConfig.getClearAccessCookieOptions(config);
  const validation = AuthCookieConfig.validateAuthCookieConfig(config);
  const ttlOptionsOk = validation.ok &&
    config.maxAgeMode === 'ttl' &&
    access.maxAge === 15 * 60 * 1000 &&
    csrf.maxAge === access.maxAge &&
    refresh.maxAge === 12 * 60 * 60 * 1000 &&
    !hasOption(access, 'expires') &&
    !hasOption(refresh, 'expires') &&
    !hasOption(csrf, 'expires') &&
    clearAccess.maxAge === 0 &&
    clearAccess.expires instanceof Date;

  if (ttlOptionsOk) {
    return pass(name, {
      cookieMaxAgeMode: config.maxAgeMode,
      accessMaxAge: access.maxAge,
      refreshMaxAge: refresh.maxAge,
      csrfMaxAge: csrf.maxAge,
      clearMaxAge: clearAccess.maxAge
    });
  }

  return fail(name, {
    errors: validation.errors,
    accessMaxAge: access.maxAge,
    refreshMaxAge: refresh.maxAge,
    csrfMaxAge: csrf.maxAge
  });
}

function expectCookieAuthDisabled(name, env) {
  const result = safeSummary(env);

  if (!result.summary.cookieAuthEnabled && result.validation.ok) {
    return pass(name, {
      authCookieMode: result.summary.authCookieMode,
      browserAuthTransport: result.summary.browserAuthTransport,
      warnings: result.validation.warnings.length
    });
  }

  return fail(name, {
    summary: result.summary,
    errors: result.validation.errors
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

function status() {
  const result = safeSummary(process.env);

  return {
    ok: result.validation.ok,
    summary: result.summary,
    warnings: result.validation.warnings,
    errors: result.validation.errors
  };
}

function validate() {
  const checks = [
    expectValid('default legacy config is parseable', {}),
    expectCookieAuthDisabled('AUTH_COOKIE_MODE=d2 without cookie transport stays disabled', {
      AUTH_COOKIE_MODE: 'd2',
      BROWSER_AUTH_TRANSPORT: 'authorization'
    }),
    expectCookieAuthDisabled('cookie transport with legacy mode stays disabled', {
      AUTH_COOKIE_MODE: 'legacy',
      BROWSER_AUTH_TRANSPORT: 'cookie'
    }),
    expectValid('d2 host cookies valid with secure exact origin', baseD2Env()),
    expectSessionCookieOptions('default d2 session cookies omit Max-Age and Expires', baseD2Env()),
    expectTtlCookieOptions('ttl mode sets Max-Age aligned to configured access and refresh TTL', baseD2Env({
      AUTH_COOKIE_MAX_AGE_MODE: 'ttl',
      JWT_EXPIRES_IN: '15m',
      REFRESH_TOKEN_TTL_HOURS: '12'
    })),
    expectValid('local http fallback names valid only with non-host cookies', baseD2Env({
      AUTH_COOKIE_ACCESS_NAME: 'medsync_dev_at',
      AUTH_COOKIE_REFRESH_NAME: 'medsync_dev_rt',
      AUTH_CSRF_COOKIE_NAME: 'medsync_dev_csrf',
      AUTH_COOKIE_SECURE: 'false',
      CORS_ALLOWED_ORIGINS: 'http://localhost:8080'
    })),
    expectInvalid('production-like d2 rejects secure false', baseD2Env({
      NODE_ENV: 'production',
      AUTH_COOKIE_SECURE: 'false',
      AUTH_COOKIE_ACCESS_NAME: 'medsync_at',
      AUTH_COOKIE_REFRESH_NAME: 'medsync_rt',
      AUTH_CSRF_COOKIE_NAME: 'medsync_csrf'
    }), 'AUTH_COOKIE_SECURE=false is invalid'),
    expectInvalid('SameSite None requires Secure', baseD2Env({
      AUTH_COOKIE_SAMESITE: 'None',
      AUTH_COOKIE_SECURE: 'false',
      AUTH_COOKIE_ACCESS_NAME: 'medsync_at',
      AUTH_COOKIE_REFRESH_NAME: 'medsync_rt',
      AUTH_CSRF_COOKIE_NAME: 'medsync_csrf'
    }), 'AUTH_COOKIE_SAMESITE=None requires AUTH_COOKIE_SECURE=true'),
    expectInvalid('__Host rejects Domain', baseD2Env({
      AUTH_COOKIE_DOMAIN: '.example.test'
    }), 'uses __Host- but AUTH_COOKIE_DOMAIN is configured'),
    expectInvalid('__Host rejects non-root Path', baseD2Env({
      AUTH_COOKIE_PATH: '/api'
    }), 'uses __Host- but path is not /'),
    expectInvalid('__Host rejects secure false', baseD2Env({
      AUTH_COOKIE_SECURE: 'false'
    }), 'uses __Host- but secure is false'),
    expectInvalid('d2 requires CSRF enabled', baseD2Env({
      CSRF_ENABLED: 'false'
    }), 'CSRF_ENABLED=true is required'),
    expectInvalid('d2 requires credentialed CORS', baseD2Env({
      CORS_CREDENTIALS: 'false'
    }), 'CORS_CREDENTIALS=true is required'),
    expectInvalid('credentialed CORS rejects wildcard', baseD2Env({
      CORS_ALLOWED_ORIGINS: '*'
    }), 'Wildcard CORS origin is invalid'),
    expectInvalid('cookie max age mode rejects invalid value', baseD2Env({
      AUTH_COOKIE_MAX_AGE_MODE: 'forever'
    }), 'AUTH_COOKIE_MAX_AGE_MODE must be one of session, ttl'),
    expectInvalid('ttl mode requires positive JWT_EXPIRES_IN', baseD2Env({
      AUTH_COOKIE_MAX_AGE_MODE: 'ttl',
      JWT_EXPIRES_IN: '0',
      REFRESH_TOKEN_TTL_HOURS: '12'
    }), 'JWT_EXPIRES_IN must be configured as a positive duration'),
    expectInvalid('ttl mode rejects invalid refresh TTL', baseD2Env({
      AUTH_COOKIE_MAX_AGE_MODE: 'ttl',
      JWT_EXPIRES_IN: '15m',
      REFRESH_TOKEN_TTL_HOURS: '-1'
    }), 'REFRESH_TOKEN_TTL_HOURS must be a positive number')
  ];

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}

function help() {
  return {
    usage: 'node scripts/qa/d2-auth-cookie-config.js [status|validate|help]',
    notes: [
      'No DB access.',
      'No fixtures.',
      'No secrets, token values, cookie values, passwords or OTPs printed.',
      'Output includes only safe config flags and non-sensitive cookie names.'
    ]
  };
}

async function main() {
  const command = process.argv[2] || 'status';
  const commands = { status, validate, help };

  if (!commands[command]) {
    throw new Error(`Unsupported command: ${command}`);
  }

  const result = commands[command]();
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

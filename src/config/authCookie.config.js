'use strict';

const PRODUCTION_ENVS = ['production', 'prod'];
const DEFAULT_AUTH_COOKIE_MODE = 'legacy';
const DEFAULT_BROWSER_AUTH_TRANSPORT = 'authorization';
const DEFAULT_ACCESS_COOKIE_NAME = '__Host-medsync_at';
const DEFAULT_REFRESH_COOKIE_NAME = '__Host-medsync_rt';
const DEFAULT_CSRF_COOKIE_NAME = '__Host-medsync_csrf';
const DEFAULT_COOKIE_PATH = '/';
const DEFAULT_COOKIE_SAMESITE = 'lax';
const DEFAULT_COOKIE_MAX_AGE_MODE = 'session';
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 30;
const AUTH_COOKIE_MODES = ['legacy', 'd2'];
const BROWSER_AUTH_TRANSPORTS = ['authorization', 'cookie'];
const SAME_SITE_VALUES = ['lax', 'none', 'strict'];
const COOKIE_MAX_AGE_MODES = ['session', 'ttl'];
const BOOLEAN_ENV_NAMES = ['AUTH_COOKIE_SECURE', 'CSRF_ENABLED', 'CORS_CREDENTIALS'];
const D2_ENV_NAMES = [
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
  'CORS_CREDENTIALS',
  'CORS_ALLOWED_ORIGINS'
];

function normalizeText(value) {
  return String(value || '').trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function getRuntimeEnv(env) {
  return normalizeText(env.APP_ENV || env.ENVIRONMENT || env.NODE_ENV || 'development');
}

function isProductionLikeRuntime(runtimeEnv) {
  return PRODUCTION_ENVS.includes(lower(runtimeEnv));
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = lower(value);
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function hasInvalidBoolean(env, name) {
  if (env[name] === undefined || env[name] === null || env[name] === '') {
    return false;
  }

  return !['true', '1', 'yes', 'y', 'on', 'false', '0', 'no', 'n', 'off'].includes(lower(env[name]));
}

function normalizeSameSite(value) {
  const normalized = lower(value || DEFAULT_COOKIE_SAMESITE);
  return SAME_SITE_VALUES.includes(normalized) ? normalized : DEFAULT_COOKIE_SAMESITE;
}

function getNullableEnv(env, name) {
  const value = normalizeText(env[name]);
  return value ? value : null;
}

function splitOrigins(value) {
  return normalizeText(value)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getCorsOriginsRaw(env) {
  if (Object.prototype.hasOwnProperty.call(env, 'CORS_ALLOWED_ORIGINS')) {
    return env.CORS_ALLOWED_ORIGINS;
  }

  if (Object.prototype.hasOwnProperty.call(env, 'CORS_ORIGIN')) {
    return env.CORS_ORIGIN;
  }

  return '*';
}

function parseDurationMs(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds * 1000 : null;
  }

  const match = raw.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const unit = match[2].toLowerCase();
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };

  return amount * multipliers[unit];
}

function getRefreshTokenTtlMs(env) {
  const hours = Number(env.REFRESH_TOKEN_TTL_HOURS);
  if (Number.isFinite(hours) && hours > 0) {
    return Math.round(hours * 60 * 60 * 1000);
  }

  const days = Number(env.REFRESH_TOKEN_TTL_DAYS);
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_REFRESH_TOKEN_TTL_DAYS;
  return Math.round(safeDays * 24 * 60 * 60 * 1000);
}

function hasInvalidPositiveNumberEnv(env, name) {
  if (env[name] === undefined || env[name] === null || env[name] === '') {
    return false;
  }

  const value = Number(env[name]);
  return !Number.isFinite(value) || value <= 0;
}

function hasD2EnvConfigured(env) {
  return D2_ENV_NAMES.some((name) => env[name] !== undefined && env[name] !== null && env[name] !== '');
}

function getAuthCookieConfig(options = {}) {
  const env = options.env || process.env;
  const runtimeEnv = options.runtimeEnv || getRuntimeEnv(env);
  const authCookieMode = lower(env.AUTH_COOKIE_MODE || DEFAULT_AUTH_COOKIE_MODE);
  const browserAuthTransport = lower(env.BROWSER_AUTH_TRANSPORT || DEFAULT_BROWSER_AUTH_TRANSPORT);
  const cookiePath = normalizeText(env.AUTH_COOKIE_PATH || DEFAULT_COOKIE_PATH);
  const accessName = normalizeText(env.AUTH_COOKIE_ACCESS_NAME || DEFAULT_ACCESS_COOKIE_NAME);
  const refreshName = normalizeText(env.AUTH_COOKIE_REFRESH_NAME || DEFAULT_REFRESH_COOKIE_NAME);
  const csrfName = normalizeText(env.AUTH_CSRF_COOKIE_NAME || env.CSRF_COOKIE_NAME || DEFAULT_CSRF_COOKIE_NAME);
  const sameSiteRaw = normalizeText(env.AUTH_COOKIE_SAMESITE || DEFAULT_COOKIE_SAMESITE);
  const sameSite = normalizeSameSite(sameSiteRaw);
  const maxAgeModeRaw = normalizeText(env.AUTH_COOKIE_MAX_AGE_MODE || DEFAULT_COOKIE_MAX_AGE_MODE);
  const maxAgeMode = lower(maxAgeModeRaw);
  const useTtlMaxAge = maxAgeMode === 'ttl';
  const secure = parseBoolean(env.AUTH_COOKIE_SECURE, true);
  const csrfEnabled = parseBoolean(env.CSRF_ENABLED, false);
  const corsCredentials = parseBoolean(env.CORS_CREDENTIALS, false);
  const corsOrigins = splitOrigins(getCorsOriginsRaw(env));
  const accessMaxAgeMs = useTtlMaxAge ? parseDurationMs(env.JWT_EXPIRES_IN) : null;
  const refreshMaxAgeMs = useTtlMaxAge ? getRefreshTokenTtlMs(env) : null;
  const productionLike = isProductionLikeRuntime(runtimeEnv);
  const isCookieAuthEnabled = authCookieMode === 'd2' && browserAuthTransport === 'cookie';

  return {
    runtimeEnv,
    productionLike,
    authCookieMode,
    browserAuthTransport,
    isCookieAuthEnabled,
    d2EnvConfigured: hasD2EnvConfigured(env),
    secure,
    sameSite,
    sameSiteRaw,
    maxAgeMode,
    maxAgeModeRaw,
    maxAgeEnabled: useTtlMaxAge,
    jwtExpiresInConfigured: Boolean(getNullableEnv(env, 'JWT_EXPIRES_IN')),
    domain: getNullableEnv(env, 'AUTH_COOKIE_DOMAIN'),
    path: cookiePath,
    csrfEnabled,
    invalidBooleanEnvNames: BOOLEAN_ENV_NAMES.filter((name) => hasInvalidBoolean(env, name)),
    invalidRefreshTtlEnvNames: ['REFRESH_TOKEN_TTL_HOURS', 'REFRESH_TOKEN_TTL_DAYS']
      .filter((name) => hasInvalidPositiveNumberEnv(env, name)),
    cookies: {
      access: {
        name: accessName,
        httpOnly: true,
        path: cookiePath,
        maxAgeMs: accessMaxAgeMs
      },
      refresh: {
        name: refreshName,
        httpOnly: true,
        path: cookiePath,
        maxAgeMs: refreshMaxAgeMs
      },
      csrf: {
        name: csrfName,
        httpOnly: false,
        path: cookiePath,
        maxAgeMs: accessMaxAgeMs
      }
    },
    cors: {
      credentials: corsCredentials,
      origins: corsOrigins,
      allowAnyOrigin: corsOrigins.includes('*')
    }
  };
}

function validateCookiePrefix(config, errors) {
  Object.keys(config.cookies).forEach((key) => {
    const cookie = config.cookies[key];
    const name = cookie.name || '';

    if (name.indexOf('__Host-') !== 0) {
      return;
    }

    if (config.domain) {
      errors.push(`${key} cookie uses __Host- but AUTH_COOKIE_DOMAIN is configured`);
    }

    if (cookie.path !== '/') {
      errors.push(`${key} cookie uses __Host- but path is not /`);
    }

    if (!config.secure) {
      errors.push(`${key} cookie uses __Host- but secure is false`);
    }
  });
}

function validateAuthCookieConfig(config = getAuthCookieConfig()) {
  const errors = [];
  const warnings = [];

  if (!AUTH_COOKIE_MODES.includes(config.authCookieMode)) {
    errors.push(`AUTH_COOKIE_MODE must be one of ${AUTH_COOKIE_MODES.join(', ')}`);
  }

  if (!BROWSER_AUTH_TRANSPORTS.includes(config.browserAuthTransport)) {
    errors.push(`BROWSER_AUTH_TRANSPORT must be one of ${BROWSER_AUTH_TRANSPORTS.join(', ')}`);
  }

  if (!SAME_SITE_VALUES.includes(lower(config.sameSiteRaw))) {
    errors.push(`AUTH_COOKIE_SAMESITE must be one of ${SAME_SITE_VALUES.join(', ')}`);
  }

  if (!COOKIE_MAX_AGE_MODES.includes(config.maxAgeMode)) {
    errors.push(`AUTH_COOKIE_MAX_AGE_MODE must be one of ${COOKIE_MAX_AGE_MODES.join(', ')}`);
  }

  config.invalidBooleanEnvNames.forEach((name) => {
    errors.push(`${name} must be boolean-like true/false`);
  });

  if (config.maxAgeMode === 'ttl') {
    config.invalidRefreshTtlEnvNames.forEach((name) => {
      errors.push(`${name} must be a positive number when AUTH_COOKIE_MAX_AGE_MODE=ttl`);
    });

    if (!config.jwtExpiresInConfigured || !config.cookies.access.maxAgeMs) {
      errors.push('JWT_EXPIRES_IN must be configured as a positive duration when AUTH_COOKIE_MAX_AGE_MODE=ttl');
    }
  }

  if (config.isCookieAuthEnabled && config.productionLike && !config.secure) {
    errors.push('AUTH_COOKIE_SECURE=false is invalid in production-like cookie auth');
  }

  if (config.sameSite === 'none' && !config.secure) {
    errors.push('AUTH_COOKIE_SAMESITE=None requires AUTH_COOKIE_SECURE=true');
  }

  validateCookiePrefix(config, errors);

  if (config.isCookieAuthEnabled && !config.csrfEnabled) {
    errors.push('CSRF_ENABLED=true is required before enabling browser cookie auth');
  }

  if (config.isCookieAuthEnabled && !config.cors.credentials) {
    errors.push('CORS_CREDENTIALS=true is required before enabling browser cookie auth');
  }

  if (config.isCookieAuthEnabled && config.cors.origins.length === 0) {
    errors.push('CORS_ALLOWED_ORIGINS must include at least one exact origin before enabling browser cookie auth');
  }

  if (config.cors.credentials && config.cors.allowAnyOrigin) {
    errors.push('Wildcard CORS origin is invalid with credentials');
  }

  if (config.authCookieMode === 'd2' && config.browserAuthTransport !== 'cookie') {
    warnings.push('AUTH_COOKIE_MODE=d2 is present but BROWSER_AUTH_TRANSPORT is not cookie; browser cookie auth remains disabled');
  }

  if (config.authCookieMode !== 'd2' && config.browserAuthTransport === 'cookie') {
    warnings.push('BROWSER_AUTH_TRANSPORT=cookie is present but AUTH_COOKIE_MODE is not d2; browser cookie auth remains disabled');
  }

  if (!config.isCookieAuthEnabled && config.d2EnvConfigured) {
    warnings.push('D2 cookie env is present while browser cookie auth remains disabled');
  }

  if (!config.productionLike && !config.secure) {
    warnings.push('AUTH_COOKIE_SECURE=false is dev/local only');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}

function assertAuthCookieConfig(config = getAuthCookieConfig()) {
  const validation = validateAuthCookieConfig(config);

  if (!validation.ok) {
    throw new Error(`[D2 AUTH COOKIE CONFIG] ${validation.errors.join('; ')}`);
  }

  return config;
}

function validateStartupAuthCookieConfig(logger = console) {
  const config = getAuthCookieConfig();
  const validation = validateAuthCookieConfig(config);
  const shouldThrow = config.isCookieAuthEnabled || (config.productionLike && config.d2EnvConfigured);

  if (!validation.ok) {
    const message = `[D2 AUTH COOKIE CONFIG] ${validation.errors.join('; ')}`;
    if (shouldThrow) {
      throw new Error(message);
    }
    logger.warn(message);
  }

  validation.warnings.forEach((warning) => logger.warn(`[D2 AUTH COOKIE CONFIG] ${warning}`));

  return {
    config,
    validation
  };
}

function getCookieOptions(type, options = {}) {
  const config = options.cookies ? options : getAuthCookieConfig(options);
  assertAuthCookieConfig(config);
  const cookie = config.cookies[type];

  if (!cookie) {
    throw new Error(`Unsupported cookie type: ${type}`);
  }

  const cookieOptions = {
    httpOnly: cookie.httpOnly,
    secure: config.secure,
    sameSite: config.sameSite,
    path: cookie.path
  };

  if (config.domain) {
    cookieOptions.domain = config.domain;
  }

  if (Number.isFinite(cookie.maxAgeMs) && cookie.maxAgeMs > 0) {
    cookieOptions.maxAge = cookie.maxAgeMs;
  }

  return cookieOptions;
}

function getClearCookieOptions(type, options = {}) {
  const cookieOptions = getCookieOptions(type, options);
  delete cookieOptions.maxAge;

  return Object.assign({}, cookieOptions, {
    expires: new Date(0),
    maxAge: 0
  });
}

function getAccessCookieOptions(options) {
  return getCookieOptions('access', options);
}

function getRefreshCookieOptions(options) {
  return getCookieOptions('refresh', options);
}

function getCsrfCookieOptions(options) {
  return getCookieOptions('csrf', options);
}

function getClearAccessCookieOptions(options) {
  return getClearCookieOptions('access', options);
}

function getClearRefreshCookieOptions(options) {
  return getClearCookieOptions('refresh', options);
}

function getClearCsrfCookieOptions(options) {
  return getClearCookieOptions('csrf', options);
}

function getCookieNames(options) {
  const config = options && options.cookies ? options : getAuthCookieConfig(options || {});

  return {
    access: config.cookies.access.name,
    refresh: config.cookies.refresh.name,
    csrf: config.cookies.csrf.name
  };
}

function getSafeAuthCookieConfigSummary(config = getAuthCookieConfig()) {
  return {
    runtimeEnv: config.runtimeEnv,
    productionLike: config.productionLike,
    authCookieMode: config.authCookieMode,
    browserAuthTransport: config.browserAuthTransport,
    cookieAuthEnabled: config.isCookieAuthEnabled,
    cookieMaxAgeMode: config.maxAgeMode,
    cookieMaxAgeEnabled: config.maxAgeEnabled,
    secure: config.secure,
    sameSite: config.sameSite,
    domainConfigured: Boolean(config.domain),
    csrfEnabled: config.csrfEnabled,
    corsCredentials: config.cors.credentials,
    corsAllowAnyOrigin: config.cors.allowAnyOrigin,
    corsOriginCount: config.cors.origins.length,
    cookieNames: getCookieNames(config)
  };
}

module.exports = {
  DEFAULT_ACCESS_COOKIE_NAME,
  DEFAULT_AUTH_COOKIE_MODE,
  DEFAULT_BROWSER_AUTH_TRANSPORT,
  DEFAULT_COOKIE_MAX_AGE_MODE,
  DEFAULT_COOKIE_PATH,
  DEFAULT_COOKIE_SAMESITE,
  DEFAULT_CSRF_COOKIE_NAME,
  DEFAULT_REFRESH_COOKIE_NAME,
  assertAuthCookieConfig,
  getAccessCookieOptions,
  getAuthCookieConfig,
  getClearAccessCookieOptions,
  getClearCsrfCookieOptions,
  getClearRefreshCookieOptions,
  getCookieNames,
  getCsrfCookieOptions,
  getRefreshCookieOptions,
  getSafeAuthCookieConfigSummary,
  validateAuthCookieConfig,
  validateStartupAuthCookieConfig
};

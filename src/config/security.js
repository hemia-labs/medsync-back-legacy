'use strict';

const AuthCookieConfig = require('./authCookie.config');

const DEFAULT_JWT_EXPIRES_IN = 60000;
const DEFAULT_JWT_SECRET = '__DEFAULT_INSECURE_JWT_SECRET_CHANGE_ME__';
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 30;
const DEFAULT_PASSWORD_RESET_CODE_TTL_MINUTES = 10;
const DEFAULT_PASSWORD_RESET_CODE_LENGTH = 6;
const DEFAULT_PASSWORD_RESET_MAX_ATTEMPTS = 5;
const DEFAULT_CSRF_TOKEN_TTL_SECONDS = 900;
const DEFAULT_CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Accept',
  'X-CSRF-Token',
  'Idempotency-Key',
  'X-Requested-With',
  'Authorization',
  'X-API-KEY',
  'Origin',
  'Access-Control-Allow-Request-Method',
  'public_key'
];
const DEFAULT_CORS_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const REFRESH_TOKEN_REUSE_SCOPES = ['session', 'family', 'user'];
const PASSWORD_RESET_CODE_ALPHABETS = ['numeric', 'alphanumeric'];
const PRODUCTION_ENVS = ['production', 'prod'];
const LOCAL_CORS_HOSTS = ['localhost', '127.0.0.1', '::1'];

function getRuntimeEnv() {
  return process.env.APP_ENV || process.env.ENVIRONMENT || process.env.NODE_ENV || 'development';
}

function isProductionLike() {
  return PRODUCTION_ENVS.includes(String(getRuntimeEnv()).toLowerCase());
}

function isActiveSessionRequired() {
  return process.env.REQUIRE_ACTIVE_SESSION === 'true';
}

function isSuperAdminSessionReauthRequired() {
  return process.env.SUPER_ADMIN_SESSION_REAUTH_REQUIRED === 'true';
}

function isRefreshTokenRotationEnabled() {
  return process.env.REFRESH_TOKEN_ROTATION_ENABLED !== 'false';
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function isWeakSecretValue(value) {
  const normalized = String(value || '').toLowerCase();
  return !value ||
    String(value).length < 32 ||
    normalized.includes('change-me') ||
    normalized.includes('replace-with') ||
    normalized.includes('default_insecure');
}

function getJwtExpiresIn() {
  const value = process.env.JWT_EXPIRES_IN || DEFAULT_JWT_EXPIRES_IN;

  if (/^\d+$/.test(String(value))) {
    return Number(value);
  }

  return value;
}

function getJwtSecretState() {
  const value = process.env.JWT_SECRET;

  return {
    configured: Boolean(value),
    isDefault: !value || value === DEFAULT_JWT_SECRET,
    isWeak: isWeakSecretValue(value)
  };
}

function getRefreshTokenSecretState() {
  const configuredSecret = process.env.REFRESH_TOKEN_SECRET;
  const fallbackSecret = process.env.JWT_SECRET;
  const value = configuredSecret || fallbackSecret;

  return {
    configured: Boolean(configuredSecret),
    usingJwtFallback: !configuredSecret && Boolean(fallbackSecret),
    effectiveConfigured: Boolean(value),
    isWeak: isWeakSecretValue(value)
  };
}

function getRefreshTokenSecret() {
  return process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
}

function getPasswordResetCodeSecretState() {
  const configuredSecret = process.env.PASSWORD_RESET_CODE_SECRET;
  const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET;
  const jwtSecret = process.env.JWT_SECRET;
  const value = configuredSecret || refreshTokenSecret || jwtSecret;

  return {
    configured: Boolean(configuredSecret),
    usingRefreshTokenFallback: !configuredSecret && Boolean(refreshTokenSecret),
    usingJwtFallback: !configuredSecret && !refreshTokenSecret && Boolean(jwtSecret),
    effectiveConfigured: Boolean(value),
    isWeak: isWeakSecretValue(value)
  };
}

function getPasswordResetCodeSecret() {
  return process.env.PASSWORD_RESET_CODE_SECRET ||
    process.env.REFRESH_TOKEN_SECRET ||
    process.env.JWT_SECRET ||
    DEFAULT_JWT_SECRET;
}

function getRefreshTokenTtlDays() {
  const hours = Number(process.env.REFRESH_TOKEN_TTL_HOURS);
  if (Number.isFinite(hours) && hours > 0) {
    return hours / 24;
  }

  const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_REFRESH_TOKEN_TTL_DAYS;
}

function getRefreshTokenTtlMs() {
  return Math.round(getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000);
}

function getPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getPasswordResetCodeTtlMinutes() {
  return getPositiveIntegerEnv('PASSWORD_RESET_CODE_TTL_MINUTES', DEFAULT_PASSWORD_RESET_CODE_TTL_MINUTES);
}

function getPasswordResetCodeLength() {
  const length = getPositiveIntegerEnv('PASSWORD_RESET_CODE_LENGTH', DEFAULT_PASSWORD_RESET_CODE_LENGTH);
  return Math.min(Math.max(length, 4), 12);
}

function getPasswordResetMaxAttempts() {
  return getPositiveIntegerEnv('PASSWORD_RESET_MAX_ATTEMPTS', DEFAULT_PASSWORD_RESET_MAX_ATTEMPTS);
}

function isCsrfEnabled() {
  return parseBoolean(process.env.CSRF_ENABLED, false);
}

function isCsrfOriginCheckEnabled() {
  return parseBoolean(process.env.CSRF_ORIGIN_CHECK_ENABLED, true);
}

function getCsrfHeaderName() {
  return String(process.env.CSRF_HEADER_NAME || 'X-CSRF-Token').trim() || 'X-CSRF-Token';
}

function getCsrfTokenTtlSeconds() {
  return getPositiveIntegerEnv('CSRF_TOKEN_TTL_SECONDS', DEFAULT_CSRF_TOKEN_TTL_SECONDS);
}

function getCsrfTokenSecretState() {
  const value = process.env.CSRF_TOKEN_SECRET;

  return {
    configured: Boolean(value),
    isWeak: isWeakSecretValue(value)
  };
}

function getCsrfTokenSecret() {
  const value = process.env.CSRF_TOKEN_SECRET;

  if (!value || isWeakSecretValue(value)) {
    throw new Error('[CSRF CONFIG] CSRF_TOKEN_SECRET is missing or too weak.');
  }

  return value;
}

function splitOriginList(value) {
  return String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function uniqueList(values) {
  const seen = new Set();

  return values.filter((value) => {
    const key = String(value).toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function splitCsvList(value, fallback) {
  const raw = value === undefined || value === null ? fallback : value;
  return uniqueList(String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean));
}

function getProcessEnvValue(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
}

function getCorsOriginsRaw() {
  const allowedOrigins = getProcessEnvValue('CORS_ALLOWED_ORIGINS');
  if (allowedOrigins !== undefined && allowedOrigins !== null) {
    return allowedOrigins;
  }

  const legacyOrigin = getProcessEnvValue('CORS_ORIGIN');
  if (legacyOrigin !== undefined && legacyOrigin !== null) {
    return legacyOrigin;
  }

  return '*';
}

function getCorsAllowedOrigins() {
  return splitCsvList(getCorsOriginsRaw(), '');
}

function getCorsAllowedHeaders() {
  return splitCsvList(
    process.env.CORS_ALLOWED_HEADERS,
    DEFAULT_CORS_ALLOWED_HEADERS.join(',')
  );
}

function getCorsAllowedMethods() {
  return splitCsvList(
    process.env.CORS_ALLOWED_METHODS,
    DEFAULT_CORS_ALLOWED_METHODS.join(',')
  ).map((method) => method.toUpperCase());
}

function getCorsMaxAgeSeconds() {
  if (!process.env.CORS_MAX_AGE_SECONDS) {
    return null;
  }

  const value = Number(process.env.CORS_MAX_AGE_SECONDS);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isCorsCredentialsEnabled() {
  return parseBoolean(process.env.CORS_CREDENTIALS, false);
}

function hasListValue(values, expected) {
  const normalizedExpected = String(expected).toLowerCase();
  return values.some((value) => String(value).toLowerCase() === normalizedExpected);
}

function isInsecureCorsOrigin(origin) {
  if (!origin || origin === '*') {
    return false;
  }

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return parsed.protocol === 'http:' && !LOCAL_CORS_HOSTS.includes(hostname);
  } catch (error) {
    return false;
  }
}

function getCsrfAllowedOrigins() {
  const origins = splitOriginList(
    process.env.CSRF_ALLOWED_ORIGINS ||
    process.env.CORS_ALLOWED_ORIGINS ||
    process.env.CORS_ORIGIN ||
    ''
  );

  return origins.filter((origin) => origin !== '*');
}

function shouldRevokePreviousPasswordResetCodes() {
  return process.env.PASSWORD_RESET_REVOKE_PREVIOUS !== 'false';
}

function getPasswordResetCodeAlphabet() {
  const alphabet = String(process.env.PASSWORD_RESET_CODE_ALPHABET || 'numeric').toLowerCase();
  return PASSWORD_RESET_CODE_ALPHABETS.includes(alphabet) ? alphabet : 'numeric';
}

function getRefreshTokenReuseRevokeScope() {
  const scope = String(process.env.REFRESH_TOKEN_REUSE_REVOKE_SCOPE || 'session').toLowerCase();
  return REFRESH_TOKEN_REUSE_SCOPES.includes(scope) ? scope : 'session';
}

function getCorsState() {
  const corsConfig = getCorsRuntimeConfig();

  return {
    configured: corsConfig.configured,
    allowAnyOrigin: corsConfig.allowAnyOrigin,
    origins: corsConfig.origins,
    credentials: corsConfig.credentials,
    allowedHeaderCount: corsConfig.allowedHeaders.length,
    allowedMethodCount: corsConfig.allowedMethods.length
  };
}

function getCorsRuntimeConfig() {
  const origins = getCorsAllowedOrigins();

  return {
    configured: Boolean(process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGIN),
    credentials: isCorsCredentialsEnabled(),
    allowAnyOrigin: origins.includes('*'),
    origins,
    allowedHeaders: getCorsAllowedHeaders(),
    allowedMethods: getCorsAllowedMethods(),
    maxAgeSeconds: getCorsMaxAgeSeconds()
  };
}

function logSecurityConfig(logger = console) {
  logger.info(`[SECURITY CONFIG] RUNTIME_ENV=${getRuntimeEnv()}`);
  logger.info(`[SECURITY CONFIG] REQUIRE_ACTIVE_SESSION=${isActiveSessionRequired()}`);
  logger.info(`[SECURITY CONFIG] SUPER_ADMIN_SESSION_REAUTH_REQUIRED=${isSuperAdminSessionReauthRequired()}`);
  logger.info(`[SECURITY CONFIG] REFRESH_TOKEN_ROTATION_ENABLED=${isRefreshTokenRotationEnabled()}`);
  logger.info(`[SECURITY CONFIG] REFRESH_TOKEN_TTL_DAYS=${getRefreshTokenTtlDays()}`);
  logger.info(`[SECURITY CONFIG] REFRESH_TOKEN_REUSE_REVOKE_SCOPE=${getRefreshTokenReuseRevokeScope()}`);
  logger.info(`[SECURITY CONFIG] JWT_EXPIRES_IN=${getJwtExpiresIn()}`);
  const jwtSecretState = getJwtSecretState();
  logger.info(`[SECURITY CONFIG] JWT_SECRET_CONFIGURED=${jwtSecretState.configured}`);
  logger.info(`[SECURITY CONFIG] JWT_SECRET_DEFAULT=${jwtSecretState.isDefault}`);
  const refreshTokenSecretState = getRefreshTokenSecretState();
  logger.info(`[SECURITY CONFIG] REFRESH_TOKEN_SECRET_CONFIGURED=${refreshTokenSecretState.configured}`);
  logger.info(`[SECURITY CONFIG] REFRESH_TOKEN_SECRET_JWT_FALLBACK=${refreshTokenSecretState.usingJwtFallback}`);
  const passwordResetSecretState = getPasswordResetCodeSecretState();
  logger.info(`[SECURITY CONFIG] PASSWORD_RESET_CODE_SECRET_CONFIGURED=${passwordResetSecretState.configured}`);
  logger.info(`[SECURITY CONFIG] PASSWORD_RESET_CODE_SECRET_REFRESH_FALLBACK=${passwordResetSecretState.usingRefreshTokenFallback}`);
  logger.info(`[SECURITY CONFIG] PASSWORD_RESET_CODE_SECRET_JWT_FALLBACK=${passwordResetSecretState.usingJwtFallback}`);
  logger.info(`[SECURITY CONFIG] PASSWORD_RESET_CODE_TTL_MINUTES=${getPasswordResetCodeTtlMinutes()}`);
  logger.info(`[SECURITY CONFIG] PASSWORD_RESET_CODE_LENGTH=${getPasswordResetCodeLength()}`);
  logger.info(`[SECURITY CONFIG] PASSWORD_RESET_MAX_ATTEMPTS=${getPasswordResetMaxAttempts()}`);
  logger.info(`[SECURITY CONFIG] PASSWORD_RESET_REVOKE_PREVIOUS=${shouldRevokePreviousPasswordResetCodes()}`);
  logger.info(`[SECURITY CONFIG] PASSWORD_RESET_CODE_ALPHABET=${getPasswordResetCodeAlphabet()}`);
  const corsState = getCorsState();
  logger.info(`[SECURITY CONFIG] CORS_ORIGIN_CONFIGURED=${corsState.configured}`);
  logger.info(`[SECURITY CONFIG] CORS_ALLOW_ANY_ORIGIN=${corsState.allowAnyOrigin}`);
  logger.info(`[SECURITY CONFIG] CORS_CREDENTIALS=${corsState.credentials}`);
  logger.info(`[SECURITY CONFIG] CORS_ALLOWED_ORIGIN_COUNT=${corsState.origins.length}`);
  logger.info(`[SECURITY CONFIG] CORS_ALLOWED_HEADER_COUNT=${corsState.allowedHeaderCount}`);
  logger.info(`[SECURITY CONFIG] CORS_ALLOWED_METHOD_COUNT=${corsState.allowedMethodCount}`);
  const authCookieState = AuthCookieConfig.getSafeAuthCookieConfigSummary();
  logger.info(`[SECURITY CONFIG] AUTH_COOKIE_MODE=${authCookieState.authCookieMode}`);
  logger.info(`[SECURITY CONFIG] BROWSER_AUTH_TRANSPORT=${authCookieState.browserAuthTransport}`);
  logger.info(`[SECURITY CONFIG] D2_COOKIE_AUTH_ENABLED=${authCookieState.cookieAuthEnabled}`);
  logger.info(`[SECURITY CONFIG] AUTH_COOKIE_MAX_AGE_MODE=${authCookieState.cookieMaxAgeMode}`);
  logger.info(`[SECURITY CONFIG] AUTH_COOKIE_SECURE=${authCookieState.secure}`);
  logger.info(`[SECURITY CONFIG] AUTH_COOKIE_SAMESITE=${authCookieState.sameSite}`);
  logger.info(`[SECURITY CONFIG] AUTH_COOKIE_DOMAIN_CONFIGURED=${authCookieState.domainConfigured}`);
  logger.info(`[SECURITY CONFIG] CSRF_ENABLED=${authCookieState.csrfEnabled}`);
  logger.info(`[SECURITY CONFIG] CORS_ALLOW_ANY_ORIGIN_WITH_CREDENTIALS=${authCookieState.corsCredentials && authCookieState.corsAllowAnyOrigin}`);
  logger.info(`[SECURITY CONFIG] CSRF_TOKEN_SECRET_CONFIGURED=${getCsrfTokenSecretState().configured}`);
  logger.info(`[SECURITY CONFIG] CSRF_ORIGIN_CHECK_ENABLED=${isCsrfOriginCheckEnabled()}`);
  logger.info(`[SECURITY CONFIG] CSRF_ALLOWED_ORIGIN_COUNT=${getCsrfAllowedOrigins().length}`);
  logger.info(`[SECURITY CONFIG] CSRF_TOKEN_TTL_SECONDS=${getCsrfTokenTtlSeconds()}`);
}

function validateStartupConfig(logger = console) {
  logSecurityConfig(logger);

  if (!isActiveSessionRequired()) {
    const message = '[SECURITY CONFIG] REQUIRE_ACTIVE_SESSION is disabled. Forced session close will not invalidate access tokens until they expire.';

    if (isProductionLike()) {
      throw new Error(`${message} Refusing to start in production-like environment.`);
    }

    logger.warn(message);
  }

  const jwtSecretState = getJwtSecretState();

  if (jwtSecretState.isDefault || jwtSecretState.isWeak) {
    const message = '[SECURITY CONFIG] JWT_SECRET is missing, default, or too weak. Configure a strong JWT_SECRET before production.';

    if (isProductionLike()) {
      throw new Error(`${message} Refusing to start in production-like environment.`);
    }

    logger.warn(message);
  }

  const refreshTokenSecretState = getRefreshTokenSecretState();

  if (!refreshTokenSecretState.configured || refreshTokenSecretState.isWeak) {
    const message = '[SECURITY CONFIG] REFRESH_TOKEN_SECRET is missing or too weak. Configure a strong REFRESH_TOKEN_SECRET before production.';

    if (isProductionLike()) {
      throw new Error(`${message} Refusing to start in production-like environment.`);
    }

    logger.warn(`${message} Falling back to JWT_SECRET only outside production-like environments.`);
  }

  if (!isRefreshTokenRotationEnabled() && isProductionLike()) {
    throw new Error('[SECURITY CONFIG] REFRESH_TOKEN_ROTATION_ENABLED is false. Refusing to start in production-like environment.');
  }

  const passwordResetSecretState = getPasswordResetCodeSecretState();

  if (!passwordResetSecretState.configured || passwordResetSecretState.isWeak) {
    const message = '[SECURITY CONFIG] PASSWORD_RESET_CODE_SECRET is missing or too weak. Configure a strong PASSWORD_RESET_CODE_SECRET before production.';

    if (isProductionLike()) {
      throw new Error(`${message} Refusing to start in production-like environment.`);
    }

    logger.warn(`${message} Falling back to REFRESH_TOKEN_SECRET or JWT_SECRET only outside production-like environments.`);
  }

  const corsState = getCorsRuntimeConfig();

  if (corsState.allowAnyOrigin && isProductionLike()) {
    throw new Error('[SECURITY CONFIG] CORS_ALLOWED_ORIGINS/CORS_ORIGIN allows any origin. Configure explicit production origins before startup.');
  }

  if (corsState.credentials && corsState.allowAnyOrigin) {
    throw new Error('[SECURITY CONFIG] CORS_CREDENTIALS=true cannot be combined with wildcard CORS origins.');
  }

  if (process.env.CORS_MAX_AGE_SECONDS && corsState.maxAgeSeconds === null) {
    const message = '[SECURITY CONFIG] CORS_MAX_AGE_SECONDS must be a positive integer when configured.';

    if (isProductionLike()) {
      throw new Error(`${message} Refusing to start in production-like environment.`);
    }

    logger.warn(message);
  }

  const insecureCorsOrigins = corsState.origins.filter(isInsecureCorsOrigin);

  if (insecureCorsOrigins.length > 0) {
    const message = '[SECURITY CONFIG] CORS allowlist contains non-local http origin(s). Use HTTPS origins outside local/dev.';

    if (isProductionLike()) {
      throw new Error(`${message} Refusing to start in production-like environment.`);
    }

    logger.warn(message);
  }

  const authCookieStartup = AuthCookieConfig.validateStartupAuthCookieConfig(logger);

  const authCookieState = AuthCookieConfig.getSafeAuthCookieConfigSummary(authCookieStartup.config);
  const csrfSecretState = getCsrfTokenSecretState();

  if (authCookieState.cookieAuthEnabled) {
    if (!corsState.credentials) {
      throw new Error('[SECURITY CONFIG] D2 cookie auth requires CORS_CREDENTIALS=true.');
    }

    if (corsState.origins.length === 0 || corsState.allowAnyOrigin) {
      throw new Error('[SECURITY CONFIG] D2 cookie auth requires a non-empty exact CORS allowlist.');
    }

    const requiredCorsHeaders = ['Content-Type', 'Accept', 'X-CSRF-Token', 'X-Requested-With'];
    if (process.env.REGISTRATION_ENABLED === 'true') requiredCorsHeaders.push('Idempotency-Key');
    const missingCorsHeaders = requiredCorsHeaders.filter((header) => !hasListValue(corsState.allowedHeaders, header));

    if (missingCorsHeaders.length > 0) {
      throw new Error(`[SECURITY CONFIG] D2 CORS preflight is missing required headers: ${missingCorsHeaders.join(', ')}.`);
    }

    const missingCorsMethods = DEFAULT_CORS_ALLOWED_METHODS.filter((method) => !hasListValue(corsState.allowedMethods, method));

    if (missingCorsMethods.length > 0) {
      throw new Error('[SECURITY CONFIG] D2 CORS preflight must allow GET, POST, PUT, PATCH, DELETE and OPTIONS.');
    }
  }

  if (isCsrfEnabled() && (!csrfSecretState.configured || csrfSecretState.isWeak)) {
    const message = '[SECURITY CONFIG] CSRF_TOKEN_SECRET is missing or too weak. Configure a strong CSRF_TOKEN_SECRET before enabling CSRF.';

    if (isProductionLike() || authCookieState.cookieAuthEnabled) {
      throw new Error(`${message} Refusing to start with active D2/production-like CSRF.`);
    }

    logger.warn(message);
  }

  if (isProductionLike() && authCookieState.cookieAuthEnabled && !isCsrfEnabled()) {
    throw new Error('[SECURITY CONFIG] D2 cookie auth requires CSRF_ENABLED=true in production-like environments.');
  }

  if (isProductionLike() && isCsrfOriginCheckEnabled() && getCsrfAllowedOrigins().length === 0) {
    throw new Error('[SECURITY CONFIG] CSRF origin check requires explicit CSRF_ALLOWED_ORIGINS/CORS_ALLOWED_ORIGINS in production-like environments.');
  }
}

module.exports = {
  DEFAULT_JWT_EXPIRES_IN,
  DEFAULT_JWT_SECRET,
  DEFAULT_PASSWORD_RESET_CODE_LENGTH,
  DEFAULT_PASSWORD_RESET_CODE_TTL_MINUTES,
  DEFAULT_PASSWORD_RESET_MAX_ATTEMPTS,
  DEFAULT_CSRF_TOKEN_TTL_SECONDS,
  DEFAULT_CORS_ALLOWED_HEADERS,
  DEFAULT_CORS_ALLOWED_METHODS,
  DEFAULT_REFRESH_TOKEN_TTL_DAYS,
  getCorsAllowedHeaders,
  getCorsAllowedMethods,
  getCorsAllowedOrigins,
  getCorsMaxAgeSeconds,
  getCorsRuntimeConfig,
  getCorsState,
  getCsrfAllowedOrigins,
  getCsrfHeaderName,
  getCsrfTokenSecret,
  getCsrfTokenSecretState,
  getCsrfTokenTtlSeconds,
  getJwtExpiresIn,
  getJwtSecretState,
  getPasswordResetCodeAlphabet,
  getPasswordResetCodeLength,
  getPasswordResetCodeSecret,
  getPasswordResetCodeSecretState,
  getPasswordResetCodeTtlMinutes,
  getPasswordResetMaxAttempts,
  getRefreshTokenReuseRevokeScope,
  getRefreshTokenSecret,
  getRefreshTokenSecretState,
  getRefreshTokenTtlDays,
  getRefreshTokenTtlMs,
  getRuntimeEnv,
  isActiveSessionRequired,
  isCsrfEnabled,
  isCsrfOriginCheckEnabled,
  isProductionLike,
  isRefreshTokenRotationEnabled,
  isSuperAdminSessionReauthRequired,
  shouldRevokePreviousPasswordResetCodes,
  validateStartupConfig
};

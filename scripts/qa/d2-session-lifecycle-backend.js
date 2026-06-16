#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');

const files = {
  authController: 'src/controller/mysql/auth.controller.js',
  authDao: 'src/Dao/mysql/auth.dao.js',
  authRoutes: 'src/routes/mysql/auth.js',
  authenticate: 'src/auth/authenticate.js',
  authCookieConfig: 'src/config/authCookie.config.js',
  sessionDao: 'src/Dao/mysql/session.Dao.js',
  tenantOperationalDao: 'src/Dao/mysql/tenantOperational.dao.js',
  superAdminRoutes: 'src/routes/mysql/super-admin.js',
  superAdminDao: 'src/Dao/mysql/superAdmin.dao.js',
  securityConfig: 'src/config/security.js',
  csrfMiddleware: 'src/middleware/csrf.middleware.js',
  corsMiddleware: 'src/middleware/corsCredentialed.middleware.js'
};

const requiredQaScripts = [
  'scripts/qa/d2-auth-cookie-config.js',
  'scripts/qa/d2-login-set-cookie.js',
  'scripts/qa/d2-refresh-cookie-rotation.js',
  'scripts/qa/d2-access-cookie-middleware.js',
  'scripts/qa/d2-logout-clear-cookies.js',
  'scripts/qa/d2-session-endpoint.js',
  'scripts/qa/d2-cookie-auth-integration.js',
  'scripts/qa/d2-cookie-auth-db-integration.js',
  'scripts/qa/d2-csrf-auth-endpoints.js',
  'scripts/qa/d2-csrf-mutating-routes-sweep.js',
  'scripts/qa/d2-cors-credentialed-allowlist.js'
];

const qaMetadata = {
  phase: 'D2-6 Backend Session Lifecycle',
  repo: 'hemia-assistance-back-legacy',
  command: 'node scripts/qa/d2-session-lifecycle-backend.js full',
  envVars: [
    'AUTH_COOKIE_MODE=d2',
    'BROWSER_AUTH_TRANSPORT=cookie',
    'CSRF_ENABLED=true',
    'CORS_CREDENTIALS=true',
    'ALLOW_D2_QA_DB=1 only for DB fixture script'
  ],
  fixtures: 'none; static source checks only',
  cleanup: 'not required; no DB or external state is modified by this script'
};

const readFile = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');

const sources = Object.entries(files).reduce((acc, [key, relativePath]) => {
  acc[key] = readFile(relativePath);
  return acc;
}, {});

const checks = [];

const addCheck = (name, ok, evidence) => {
  checks.push({
    name,
    status: ok ? 'OK' : 'FAIL',
    evidence
  });
};

const includesAll = (source, needles) => needles.every((needle) => source.includes(needle));

const assertIncludesAll = (name, source, needles, evidence) => {
  addCheck(name, includesAll(source, needles), evidence);
};

const assertNoMatches = (name, sourceMap, patterns, evidence) => {
  const offenders = [];

  Object.entries(sourceMap).forEach(([fileKey, source]) => {
    patterns.forEach((pattern) => {
      if (pattern.test(source)) {
        offenders.push(`${fileKey}:${pattern}`);
      }
    });
  });

  addCheck(name, offenders.length === 0, offenders.length ? offenders.join(', ') : evidence);
};

addCheck(
  'all backend D2 QA scripts exist',
  requiredQaScripts.every((relativePath) => fs.existsSync(path.join(rootDir, relativePath))),
  requiredQaScripts.join(', ')
);

assertIncludesAll(
  'login D2 sets auth cookies and returns tokenless JSON',
  sources.authController,
  [
    'function applyD2LoginCookies',
    'res.cookie(names.access, accessToken',
    'res.cookie(names.refresh, refreshToken',
    'response.data = buildD2AuthResponseData(data)'
  ],
  'D2 login applies access/refresh cookies and rewrites JSON through D2 tokenless response builder.'
);

assertIncludesAll(
  'session D2 with valid cookie returns authenticated true',
  `${sources.authController}\n${sources.authDao}\n${sources.sessionDao}`,
  [
    'buildD2SessionResponseData(response.data)',
    'authenticated: true',
    'user: {',
    'id_login: decoded.id_login || null',
    'return await buildAuthResponseForSession(body.id_login, body.id_session, null)',
    'checkActiveSession'
  ],
  'Session endpoint validates active server session and maps tokenless user.id_login DTO.'
);

assertIncludesAll(
  'session D2 without cookie returns authenticated false',
  sources.authController,
  [
    'responseData.success({ authenticated: false }',
    'if (!req.tokenDecode)',
    'auth.session.anonymous',
    'res.status(response.status).send(response)'
  ],
  'Session endpoint returns anonymous response when no access cookie/token context exists.'
);

assertIncludesAll(
  'refresh D2 uses refresh cookie and not request body fallback',
  sources.authController,
  [
    'function getD2RefreshRequestBody(req)',
    'const refreshToken = req && req.cookies ? req.cookies[names.refresh] : null',
    'id_refresh_token: refreshToken || null',
    'hasRefreshToken: Boolean(refreshToken)',
    'if (d2CookieAuth) {',
    'getD2RefreshRequestBody(req)'
  ],
  'D2 controller builds refresh body from HttpOnly cookie only.'
);

assertIncludesAll(
  'refresh rotation invalidates previous refresh token',
  sources.authDao,
  [
    'const nextToken = await insertRefreshTokenRecord',
    'parentTokenHash: row.token_hash',
    'const rotated = await markRefreshTokenRotated(row, transaction)',
    'rotated_at = NOW()',
    'revoked_reason = COALESCE(revoked_reason, \'rotated\')',
    'response.data.refresh_token = nextToken.rawToken'
  ],
  'Refresh v2 inserts child token, marks old token rotated/revoked, returns new raw token internally.'
);

assertIncludesAll(
  'refresh reuse detection fails with old refresh token',
  sources.authDao,
  [
    'if (row.rotated_at || row.reused_at)',
    'return handleRefreshTokenReuse(row, parsed.tokenFingerprint)',
    'reused_at = COALESCE(reused_at, NOW())',
    'revoked_reason = COALESCE(revoked_reason, \'reuse_detected\')',
    'reason: \'reuse_detected_family\'',
    'event: \'auth.refresh.reused_detected\''
  ],
  'Reuse path marks reused token/family and does not issue a new token.'
);

assertIncludesAll(
  'logout D2 revokes session and clears cookies',
  `${sources.authController}\n${sources.authDao}`,
  [
    'AuthDao.close(_body)',
    'clearD2AuthCookies(res)',
    'SET active = 0',
    'active = 1 OR',
    'last',
    'await revokeRefreshTokens(body.id_login',
    'reason: \'logout\''
  ],
  'Logout uses decoded id_login/id_session, revokes server session/refresh and clears cookies.'
);

assertIncludesAll(
  'old access after logout fails through active session check',
  `${sources.authController}\n${sources.authDao}\n${sources.sessionDao}`,
  [
    'reason: \'inactive_or_revoked_session\'',
    'buildAuthResponseForSession',
    'SessionDao.checkActiveSession',
    'AND active = 1',
    'clearD2AuthCookiesBestEffort'
  ],
  'Session endpoint rejects revoked/inactive sessions and clears D2 cookies best effort.'
);

assertIncludesAll(
  'refresh after logout fails because refresh records are revoked',
  sources.authDao,
  [
    'await revokeRefreshTokens(body.id_login',
    'idSession: body.id_session',
    'reason: \'logout\'',
    'if (row.revoked_at || Number(row.last) !== 1)',
    'return responseData.notSuccess(Messages.AUTH_NOT_FOUND)'
  ],
  'Logout revokes session-bound refresh tokens; refresh rejects revoked/non-last records.'
);

assertIncludesAll(
  'Super Admin close session invalidates access and refresh',
  `${sources.superAdminRoutes}\n${sources.superAdminDao}`,
  [
    "router.patch('/sessions/:id/close', Token.Auth, csrfProtected, requireRole('super_admin')",
    'async closeSession',
    'SET active = 0',
    'revoked_reason = COALESCE(revoked_reason, \'super_admin_close_session\')',
    'id_session COLLATE'
  ],
  'Super Admin individual close revokes target session and session-bound refresh records.'
);

assertIncludesAll(
  'Super Admin close user sessions invalidates all active sessions and refresh',
  `${sources.superAdminRoutes}\n${sources.superAdminDao}`,
  [
    "router.patch('/users/:id/close-sessions', Token.Auth, csrfProtected, requireRole('super_admin')",
    'async closeUserSessions',
    'AND active = 1',
    'revoked_reason = COALESCE(revoked_reason, \'super_admin_close_user_sessions\')',
    'refresh_invalidation_scope: \'user_active_refresh_records\''
  ],
  'Super Admin bulk close revokes active sessions and active refresh records for target user.'
);

assertIncludesAll(
  'reset password invalidates sessions and refresh tokens',
  sources.authDao,
  [
    'async reseetPassword',
    'await revokeActivePasswordResetTokens(account.id_login',
    'await invalidateAuthArtifacts(account.id_login, null, null, transaction)',
    'SET active = 0',
    'await revokeRefreshTokens(idLogin'
  ],
  'Reset password consumes challenge and invalidates auth artifacts for the account.'
);

assertIncludesAll(
  'tenant suspended or restricted is reflected in session',
  `${sources.authController}\n${sources.authDao}\n${sources.tenantOperationalDao}`,
  [
    'TenantOperationalDao',
    'getTenantAuthenticationState',
    'tenantOperational: tenantState.tenantOperational',
    'buildTenantOperationalSessionData',
    'allowed: tenant.allowed === true',
    'code: tenant.code || null'
  ],
  'Session/login/refresh DTO carries tenantOperational state from tenant checks.'
);

assertIncludesAll(
  'inactive user is rejected by auth/session DAO paths',
  sources.authDao,
  [
    'AND active = 1',
    'AND l.active = 1',
    'getPasswordResetAccountById',
    'WHERE id_login COLLATE'
  ],
  'DAO filters active login rows in auth/account paths.'
);

assertIncludesAll(
  'cookie config keeps auth cookies HttpOnly',
  sources.authCookieConfig,
  [
    'httpOnly: true',
    'getAccessCookieOptions',
    'getRefreshCookieOptions',
    'getClearAccessCookieOptions',
    'getClearRefreshCookieOptions'
  ],
  'Access/refresh cookie helpers are HttpOnly and have clear options.'
);

assertIncludesAll(
  'CSRF and CORS remain required for browser D2 lifecycle',
  `${sources.csrfMiddleware}\n${sources.corsMiddleware}\n${sources.securityConfig}`,
  [
    'X-CSRF-Token',
    'Access-Control-Allow-Credentials',
    'Vary',
    'Origin'
  ],
  'Lifecycle depends on existing CSRF header and credentialed CORS allowlist.'
);

assertNoMatches(
  'backend lifecycle source set does not print secrets',
  sources,
  [
    /console\.(log|info|warn|error)\s*\([^)]*(password|otp|access token|refresh token|cookie|csrf|authorization)/i
  ],
  'No direct console output of secret terms found in D2 lifecycle source set.'
);

const command = process.argv[2] || 'status';
const allowedCommands = ['status', 'validate', 'full'];

if (!allowedCommands.includes(command)) {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.stderr.write(`Usage: ${qaMetadata.command}\n`);
  process.exit(2);
}

const failed = checks.filter((check) => check.status !== 'OK');
const result = {
  ...qaMetadata,
  requestedCommand: command,
  summary: failed.length === 0 ? 'OK' : 'FAIL',
  checks
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (failed.length > 0) {
  process.exit(1);
}

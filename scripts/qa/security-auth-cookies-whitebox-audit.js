'use strict';

require('../../src/config/env');

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const AuthCookieConfig = require('../../src/config/authCookie.config');
const CsrfTokenService = require('../../src/services/security/csrfToken.service');
const SecurityConfig = require('../../src/config/security');
const { resolveAllowedOrigin } = require('../../src/middleware/corsCredentialed.middleware');

const ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_ROOT = path.resolve(ROOT, '..', 'hemia-assistance-front-legacy');
const MUTATING_METHODS = ['post', 'put', 'patch', 'delete'];
const CLINICAL_ROUTE_FILES = [
  'src/routes/mysql/px.js',
  'src/routes/mysql/file.js',
  'src/routes/mysql/treatment.js',
  'src/routes/mysql/tracing.js',
  'src/routes/mysql/odontogram.js',
  'src/routes/mysql/clinical-history.js',
  'src/routes/mysql/prescription.js',
  'src/routes/mysql/document.js'
];
const LEGACY_PERMISSION_GAP_FILES = [
  'src/routes/mysql/user.js',
  'src/routes/mysql/px.js',
  'src/routes/mysql/appointment.js',
  'src/routes/mysql/config.js'
];

function read(relativePath, root = ROOT) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath, root = ROOT) {
  return fs.existsSync(path.join(root, relativePath));
}

function check(name, ok, severity, evidence, recommendation) {
  return {
    name,
    ok: Boolean(ok),
    status: ok ? 'PASS' : 'FAIL',
    severity: ok ? 'info' : severity,
    evidence: evidence || {},
    recommendation: recommendation || null
  };
}

function info(name, evidence) {
  return {
    name,
    ok: true,
    status: 'INFO',
    severity: 'info',
    evidence: evidence || {},
    recommendation: null
  };
}

function withEnv(overrides, fn) {
  const snapshot = {};
  Object.keys(overrides).forEach((key) => {
    snapshot[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  });

  try {
    return fn();
  } finally {
    Object.keys(overrides).forEach((key) => {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    });
  }
}

function d2Env(overrides = {}) {
  return Object.assign({
    APP_ENV: 'development',
    NODE_ENV: 'development',
    AUTH_COOKIE_MODE: 'd2',
    BROWSER_AUTH_TRANSPORT: 'cookie',
    AUTH_COOKIE_ACCESS_NAME: '__Host-medsync_at',
    AUTH_COOKIE_REFRESH_NAME: '__Host-medsync_rt',
    AUTH_CSRF_COOKIE_NAME: '__Host-medsync_csrf',
    AUTH_COOKIE_SECURE: 'true',
    AUTH_COOKIE_SAMESITE: 'lax',
    AUTH_COOKIE_DOMAIN: '',
    AUTH_COOKIE_PATH: '/',
    AUTH_COOKIE_MAX_AGE_MODE: 'ttl',
    JWT_EXPIRES_IN: '15m',
    REFRESH_TOKEN_TTL_HOURS: '12',
    CSRF_ENABLED: 'true',
    CSRF_TOKEN_SECRET: 'qa-csrf-secret-at-least-32-characters-long',
    CSRF_ALLOWED_ORIGINS: 'https://app.example.test',
    CORS_CREDENTIALS: 'true',
    CORS_ALLOWED_ORIGINS: 'https://app.example.test',
    JWT_SECRET: 'qa-jwt-secret-at-least-32-characters-long',
    REFRESH_TOKEN_SECRET: 'qa-refresh-secret-at-least-32-characters-long',
    PASSWORD_RESET_CODE_SECRET: 'qa-reset-secret-at-least-32-characters-long',
    REQUIRE_ACTIVE_SESSION: 'true'
  }, overrides);
}

function auditCookieConfig() {
  return withEnv(d2Env(), () => {
    const config = AuthCookieConfig.getAuthCookieConfig();
    const validation = AuthCookieConfig.validateAuthCookieConfig(config);
    const names = AuthCookieConfig.getCookieNames(config);
    const access = AuthCookieConfig.getAccessCookieOptions(config);
    const refresh = AuthCookieConfig.getRefreshCookieOptions(config);
    const csrf = AuthCookieConfig.getCsrfCookieOptions(config);
    const clearAccess = AuthCookieConfig.getClearAccessCookieOptions(config);

    const flagsOk = validation.ok &&
      config.isCookieAuthEnabled === true &&
      names.access.indexOf('__Host-') === 0 &&
      names.refresh.indexOf('__Host-') === 0 &&
      names.csrf.indexOf('__Host-') === 0 &&
      access.httpOnly === true &&
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
      csrf.path === '/' &&
      access.maxAge === 15 * 60 * 1000 &&
      refresh.maxAge === 12 * 60 * 60 * 1000 &&
      clearAccess.maxAge === 0 &&
      clearAccess.expires instanceof Date;

    const wildcardValidation = AuthCookieConfig.validateAuthCookieConfig(
      AuthCookieConfig.getAuthCookieConfig({
        env: d2Env({ CORS_ALLOWED_ORIGINS: '*' })
      })
    );
    const csrfOffValidation = AuthCookieConfig.validateAuthCookieConfig(
      AuthCookieConfig.getAuthCookieConfig({
        env: d2Env({ CSRF_ENABLED: 'false' })
      })
    );

    return [
      check('D2 auth cookies use HttpOnly/Secure/SameSite/path/TTL/clear flags', flagsOk, 'critical', {
        validationOk: validation.ok,
        cookieNames: names,
        accessHttpOnly: access.httpOnly,
        refreshHttpOnly: refresh.httpOnly,
        csrfHttpOnly: csrf.httpOnly,
        secure: access.secure,
        sameSite: access.sameSite,
        path: access.path,
        accessMaxAgeMs: access.maxAge,
        refreshMaxAgeMs: refresh.maxAge,
        clearMaxAge: clearAccess.maxAge
      }, 'Keep these assertions green for the exact production env values.'),
      check('D2 config rejects wildcard CORS with credentials', wildcardValidation.ok === false, 'critical', {
        errors: wildcardValidation.errors
      }, 'Use exact HTTPS origins only.'),
      check('D2 config rejects cookie auth without CSRF', csrfOffValidation.ok === false, 'critical', {
        errors: csrfOffValidation.errors
      }, 'Keep CSRF_ENABLED=true before enabling browser cookie auth.')
    ];
  });
}

function fakeReq({ method = 'POST', cookieToken = null, headerToken = null, idLogin = 'user-a', idSession = 'session-a', origin = 'https://app.example.test' } = {}) {
  const headers = {};
  if (headerToken) {
    headers['x-csrf-token'] = headerToken;
  }
  if (origin) {
    headers.origin = origin;
  }

  return {
    method,
    headers,
    cookies: cookieToken ? { [CsrfTokenService.csrfCookieName()]: cookieToken } : {},
    tokenDecode: idLogin && idSession ? { id_login: idLogin, id_session: idSession } : null
  };
}

function auditCsrf() {
  return withEnv(d2Env(), () => {
    const issued = CsrfTokenService.issueToken(fakeReq());
    const safeGet = CsrfTokenService.validateDoubleSubmit(fakeReq({ method: 'GET' }));
    const missing = CsrfTokenService.validateDoubleSubmit(fakeReq({ method: 'POST' }));
    const mismatch = CsrfTokenService.validateDoubleSubmit(fakeReq({
      method: 'POST',
      cookieToken: issued.token,
      headerToken: `${issued.token}x`
    }));
    const valid = CsrfTokenService.validateDoubleSubmit(fakeReq({
      method: 'POST',
      cookieToken: issued.token,
      headerToken: issued.token
    }));
    const crossSession = CsrfTokenService.validateDoubleSubmit(fakeReq({
      method: 'POST',
      cookieToken: issued.token,
      headerToken: issued.token,
      idLogin: 'user-b',
      idSession: 'session-b'
    }));

    return [
      check('CSRF skips safe methods and enforces mutating cookie/header token', safeGet.ok && safeGet.skipped && !missing.ok && !mismatch.ok && valid.ok, 'critical', {
        safeGet,
        missingReason: missing.reason,
        mismatchReason: mismatch.reason,
        validContext: valid.payload ? valid.payload.contextType : null
      }, 'Keep GET/HEAD/OPTIONS non-mutating and require CSRF on authenticated mutating requests.'),
      check('CSRF token is bound to the issuing session', crossSession.ok === false && crossSession.reason === 'bad_binding', 'critical', {
        crossSessionReason: crossSession.reason
      }, 'Do not accept session-bound CSRF tokens across users or sessions.')
    ];
  });
}

function auditCors() {
  const config = {
    credentials: true,
    allowAnyOrigin: false,
    origins: ['https://app.example.test'],
    allowedHeaders: SecurityConfig.DEFAULT_CORS_ALLOWED_HEADERS,
    allowedMethods: SecurityConfig.DEFAULT_CORS_ALLOWED_METHODS,
    maxAgeSeconds: null
  };
  const allowed = resolveAllowedOrigin('https://app.example.test', config);
  const rejected = resolveAllowedOrigin('https://evil.example.test', config);
  const wildcardWithCredentials = resolveAllowedOrigin('https://anything.example.test', {
    ...config,
    allowAnyOrigin: true,
    origins: ['*']
  });

  return [
    check('CORS resolves exact allowlist origin and rejects malicious origin', allowed === 'https://app.example.test' && rejected === null, 'critical', {
      allowed,
      rejected
    }, 'Keep CORS_ALLOWED_ORIGINS explicit and environment-specific.'),
    check('CORS helper does not emit wildcard origin while credentials are enabled', wildcardWithCredentials === null, 'critical', {
      wildcardWithCredentials
    }, 'Never combine Access-Control-Allow-Origin: * with credentials.')
  ];
}

function parseRouteLines() {
  const routeDir = path.join(ROOT, 'src', 'routes', 'mysql');
  return fs.readdirSync(routeDir)
    .filter((file) => file.endsWith('.js'))
    .flatMap((file) => {
      const rel = path.join('src', 'routes', 'mysql', file).replace(/\\/g, '/');
      return read(rel).split(/\r?\n/).map((line, index) => ({ file: rel, line: index + 1, text: line.trim() }));
    })
    .filter((item) => /router\.(get|post|put|patch|delete)\s*\(/.test(item.text))
    .map((item) => {
      const methodMatch = item.text.match(/router\.(get|post|put|patch|delete)\s*\(/);
      return {
        ...item,
        method: methodMatch ? methodMatch[1].toUpperCase() : null,
        auth: item.text.includes('Token.Auth'),
        optionalAuth: item.text.includes('Token.OptionalAuth'),
        csrf: item.text.includes('csrfProtected') || item.text.includes('csrfAuthEndpoint'),
        role: item.text.includes('requireRole') ||
          item.text.includes('requirePermission') ||
          item.text.includes('requireAnyPermission') ||
          item.text.includes('requireSelfOrPermission'),
        tenant: item.text.includes('requireTenantOperational')
      };
    });
}

function auditRoutes() {
  const routes = parseRouteLines();
  const mutatingAuthWithoutCsrf = routes.filter((route) => (
    MUTATING_METHODS.includes(route.method.toLowerCase()) &&
    route.auth &&
    !route.csrf
  ));
  const clinicalRoutesWithoutTenant = routes.filter((route) => (
    CLINICAL_ROUTE_FILES.includes(route.file) &&
    route.auth &&
    !route.tenant
  ));

  return [
    check('Authenticated mutating routes include CSRF middleware', mutatingAuthWithoutCsrf.length === 0, 'critical', {
      findings: mutatingAuthWithoutCsrf
    }, 'Add csrfProtection() before handlers for every authenticated POST/PUT/PATCH/DELETE route.'),
    check('Clinical tenant routes include tenant middleware', clinicalRoutesWithoutTenant.length === 0, 'critical', {
      findings: clinicalRoutesWithoutTenant
    }, 'Keep requireTenantOperational on tenant-scoped clinical routes.')
  ];
}

function auditSuperAdminIsolation() {
  const middleware = read('src/middleware/requireTenantOperational.middleware.js');
  const bypassPattern = /if\s*\(\s*isSuperAdminRole\s*\([^)]*\)\s*\)\s*\{\s*next\s*\(\s*\)\s*;\s*return\s*;\s*\}/m;
  const hasBypass = bypassPattern.test(middleware);
  const hasExplicitDeny = middleware.includes('SUPER_ADMIN_PHI_FORBIDDEN') &&
    middleware.includes('authz.super_admin_phi_denied') &&
    middleware.includes('res.status(403)');
  const affectedRoutes = parseRouteLines().filter((route) => (
    CLINICAL_ROUTE_FILES.includes(route.file) &&
    route.auth &&
    route.tenant
  ));

  return [
    check('super_admin is blocked from tenant clinical/PHI routes', !hasBypass && hasExplicitDeny, 'critical', {
      bypassFound: hasBypass,
      explicitDenyFound: hasExplicitDeny,
      affectedRouteCount: affectedRoutes.length,
      affectedRouteExamples: affectedRoutes.slice(0, 8)
    }, 'Replace the blanket super_admin bypass with an explicit deny for clinical/PHI routes and a separate allowlist for platform-only endpoints.')
  ];
}

function auditBackendPermissions() {
  const gaps = LEGACY_PERMISSION_GAP_FILES.map((routeFile) => {
    const routeText = read(routeFile);
    const hasRequirePermissionImport = routeText.includes('requirePermission.middleware');
    const mutatingRoutes = routeText.split(/\r?\n/)
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter((item) => /router\.(post|put|patch|delete)\s*\(/.test(item.text) && item.text.includes('Token.Auth'));
    const unprotectedMutatingRoutes = mutatingRoutes.filter((item) => !(
      item.text.includes('requirePermission') ||
      item.text.includes('requireAnyPermission') ||
      item.text.includes('requireSelfOrPermission')
    ));
    return {
      routeFile,
      mutatingRouteCount: mutatingRoutes.length,
      hasRoutePermissionMiddleware: hasRequirePermissionImport,
      unprotectedMutatingRoutes,
      mutatingRoutes
    };
  }).filter((item) => item.mutatingRouteCount > 0 && item.unprotectedMutatingRoutes.length > 0);

  const middlewareText = read('src/middleware/requirePermission.middleware.js');
  const middlewareSignals = {
    exists: exists('src/middleware/requirePermission.middleware.js'),
    usesForbidden403: middlewareText.includes('responseData.forbidden') && middlewareText.includes('AUTHZ_FORBIDDEN'),
    logsDenied: middlewareText.includes('authz.access_denied'),
    usesCatalogPermissions: middlewareText.includes('UserDao.hasPermission')
  };

  return [
    check('Legacy operational routes have backend role/permission gates', gaps.length === 0 && middlewareSignals.usesForbidden403 && middlewareSignals.logsDenied && middlewareSignals.usesCatalogPermissions, 'high', {
      routeGaps: gaps,
      middlewareSignals
    }, 'Add backend permission middleware or DAO-level hasPermission checks for users, patients, appointments and tenant configuration.')
  ];
}

function auditFrontendD2() {
  if (!fs.existsSync(FRONTEND_ROOT)) {
    return [check('Frontend repository is available for D2 audit', false, 'medium', {
      expectedPath: FRONTEND_ROOT
    }, 'Set FRONTEND_ROOT or run from the expected workspace layout.')];
  }

  const authConfig = read('src/services/config/authTransport.config.js', FRONTEND_ROOT);
  const axiosHelper = read('src/services/config/axios.helper.js', FRONTEND_ROOT);
  const mutations = read('src/store/modules/auth/mutations.js', FRONTEND_ROOT);
  const actions = read('src/store/modules/auth/actions.js', FRONTEND_ROOT);

  const d2Configured = authConfig.includes('VUE_APP_AUTH_COOKIE_MODE') &&
    authConfig.includes('VUE_APP_BROWSER_AUTH_TRANSPORT') &&
    authConfig.includes('isD2AuthMode');
  const d2Axios = axiosHelper.includes('withCredentials: true') &&
    axiosHelper.includes('removeAuthorizationHeader') &&
    axiosHelper.includes('DACsrfService.getCsrfHeader()');
  const d2StoreNoPersist = mutations.includes('if(isD2AuthMode())') &&
    mutations.includes('state.token = null') &&
    mutations.includes('state.refreshtoken = null');
  const d2RefreshCookieOnly = actions.includes('if(isD2AuthMode())') &&
    actions.includes('DAAuthService.refreshToken()');

  return [
    check('Frontend D2 mode sends credentials, strips Authorization and injects CSRF on mutating requests', d2Configured && d2Axios, 'critical', {
      d2Configured,
      d2Axios
    }, 'Keep all browser auth calls on shared axios helper in D2 mode.'),
    check('Frontend D2 store avoids readable access/refresh token persistence', d2StoreNoPersist && d2RefreshCookieOnly, 'critical', {
      d2StoreNoPersist,
      d2RefreshCookieOnly
    }, 'Do not reintroduce vue-session/localStorage/sessionStorage token writes in D2 branches.')
  ];
}

function auditSecurityHeaders() {
  const packageJson = JSON.parse(read('package.json'));
  const index = read('src/index.js');
  const noStore = read('src/middleware/noStore.middleware.js');
  const securityHeaders = exists('src/middleware/securityHeaders.middleware.js')
    ? read('src/middleware/securityHeaders.middleware.js')
    : '';
  const headerSources = `${index}\n${noStore}\n${securityHeaders}`;
  const hasHelmetDependency = Boolean(packageJson.dependencies && packageJson.dependencies.helmet);
  const hasHelmetUse = index.includes('helmet(');
  const hasHelmetEquivalent = (hasHelmetDependency && hasHelmetUse) ||
    (index.includes('securityHeaders()') && securityHeaders.includes('Content-Security-Policy-Report-Only'));
  const headers = {
    cacheControl: headerSources.includes('Cache-Control'),
    referrerPolicy: headerSources.includes('Referrer-Policy'),
    contentTypeOptions: headerSources.includes('X-Content-Type-Options'),
    csp: headerSources.includes('Content-Security-Policy'),
    cspReportOnly: headerSources.includes('Content-Security-Policy-Report-Only'),
    frame: headerSources.includes('X-Frame-Options') && headerSources.includes('frame-ancestors'),
    hsts: headerSources.includes('Strict-Transport-Security') && headerSources.includes('isHttpsRequest'),
    permissions: headerSources.includes('Permissions-Policy')
  };

  return [
    check('API security headers include Helmet/equivalent CSP/frame/HSTS/Permissions policy', hasHelmetEquivalent && headers.csp && headers.frame && headers.hsts && headers.permissions, 'medium', {
      hasHelmetDependency,
      hasHelmetUse,
      hasHelmetEquivalent,
      headers
    }, 'Keep Helmet or equivalent middleware with environment-aware CSP, frame-ancestors/X-Frame-Options, HSTS only on HTTPS production-like requests, Referrer-Policy, X-Content-Type-Options and Permissions-Policy.'),
    check('API no-store middleware protects API cache/referrer/content-type basics', headers.cacheControl && headers.referrerPolicy && headers.contentTypeOptions, 'low', {
      headers
    }, 'Keep no-store on /api responses.')
  ];
}

function gitTrackedEnvFiles(root) {
  try {
    const output = childProcess.execFileSync('git', ['ls-files', '.env', '.env.*'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    return [];
  }
}

function parseEnvFileSafe(relativePath, root) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    return { exists: false, keys: {} };
  }

  const keys = {};
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === '#') {
      return;
    }
    const index = line.indexOf('=');
    if (index < 0) {
      return;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    keys[key] = {
      present: true,
      empty: value.length === 0,
      length: value.length
    };
  });
  return { exists: true, keys };
}

function envFileUsesHttpApi(relativePath, root) {
  return exists(relativePath, root) &&
    /VUE_APP_CORE_URL_API\s*=\s*http:\/\//i.test(read(relativePath, root));
}

function auditSecretsAndEnv() {
  const backendTracked = gitTrackedEnvFiles(ROOT);
  const frontendTracked = fs.existsSync(FRONTEND_ROOT) ? gitTrackedEnvFiles(FRONTEND_ROOT) : [];
  const backendTrackedUnsafe = backendTracked.filter((file) => file !== '.env.example');
  const frontendTrackedUnsafe = frontendTracked.filter((file) => file !== '.env.example');
  const backendLocal = parseEnvFileSafe('.env.local', ROOT);
  const frontendLocal = fs.existsSync(FRONTEND_ROOT)
    ? parseEnvFileSafe('.env.local', FRONTEND_ROOT)
    : { exists: false, keys: {} };
  const frontendProduction = fs.existsSync(FRONTEND_ROOT)
    ? parseEnvFileSafe('.env.production', FRONTEND_ROOT)
    : { exists: false, keys: {} };
  const frontendStaging = fs.existsSync(FRONTEND_ROOT)
    ? parseEnvFileSafe('.env.staging', FRONTEND_ROOT)
    : { exists: false, keys: {} };
  const frontendPackageJson = fs.existsSync(path.join(FRONTEND_ROOT, 'package.json'))
    ? JSON.parse(read('package.json', FRONTEND_ROOT))
    : { scripts: {} };
  const frontendScripts = frontendPackageJson.scripts || {};

  const backendD2LocalEnabled = backendLocal.keys.AUTH_COOKIE_MODE &&
    backendLocal.keys.BROWSER_AUTH_TRANSPORT &&
    backendLocal.keys.CSRF_ENABLED &&
    backendLocal.keys.CORS_CREDENTIALS;
  const frontendD2LocalEnabled = frontendLocal.keys.VUE_APP_AUTH_COOKIE_MODE &&
    frontendLocal.keys.VUE_APP_BROWSER_AUTH_TRANSPORT &&
    frontendLocal.keys.VUE_APP_CSRF_ENABLED;
  const frontendProdUsesHttp = envFileUsesHttpApi('.env.production', FRONTEND_ROOT);
  const frontendStagingUsesHttp = envFileUsesHttpApi('.env.staging', FRONTEND_ROOT);
  const frontendHttpsGuard = exists('scripts/qa/enforce-https-api-url.js', FRONTEND_ROOT) &&
    /enforce-https-api-url\.js production/.test(frontendScripts.prebuild || '') &&
    /enforce-https-api-url\.js staging/.test(frontendScripts['prebuild-stage'] || '');

  return [
    check('No non-example env files are tracked by git', backendTrackedUnsafe.length === 0 && frontendTrackedUnsafe.length === 0, 'critical', {
      backendTracked,
      frontendTracked
    }, 'Keep real env files ignored and manage production secrets outside git.'),
    check('Local env has D2 cookie-auth flags enabled for audit runtime', Boolean(backendD2LocalEnabled && frontendD2LocalEnabled), 'high', {
      backendEnvLocalExists: backendLocal.exists,
      frontendEnvLocalExists: frontendLocal.exists,
      backendD2FlagKeysPresent: Boolean(backendD2LocalEnabled),
      frontendD2FlagKeysPresent: Boolean(frontendD2LocalEnabled)
    }, 'Run the full browser/integration audit with AUTH_COOKIE_MODE=d2, BROWSER_AUTH_TRANSPORT=cookie, CSRF_ENABLED=true, CORS_CREDENTIALS=true and matching frontend VUE_APP flags.'),
    check('Frontend staging/production API URLs are HTTPS and guarded at build', !frontendProdUsesHttp && !frontendStagingUsesHttp && frontendHttpsGuard, 'high', {
      frontendProductionExists: frontendProduction.exists,
      frontendStagingExists: frontendStaging.exists,
      productionHttpUrlDetected: frontendProdUsesHttp,
      stagingHttpUrlDetected: frontendStagingUsesHttp,
      frontendHttpsGuard
    }, 'Use HTTPS API origins in production/staging builds and keep build guards that reject http:// VUE_APP_CORE_URL_API.')
  ];
}

function auditExistingQaCoverage() {
  const expectedBackendScripts = [
    'scripts/qa/d2-auth-cookie-config.js',
    'scripts/qa/d2-login-set-cookie.js',
    'scripts/qa/d2-refresh-cookie-rotation.js',
    'scripts/qa/d2-access-cookie-middleware.js',
    'scripts/qa/d2-logout-clear-cookies.js',
    'scripts/qa/d2-csrf-auth-endpoints.js',
    'scripts/qa/d2-csrf-mutating-routes-sweep.js',
    'scripts/qa/d2-cors-credentialed-allowlist.js',
    'scripts/qa/d2-session-lifecycle-backend.js'
  ];
  const expectedFrontendScripts = [
    'scripts/qa/d2-store-token-removal.js',
    'scripts/qa/d2-session-lifecycle-frontend.js',
    'scripts/qa/d2-router-session-hydration.js',
    'scripts/qa/d2-logout-401-cleanup.js',
    'scripts/qa/d2-frontend-regression.js',
    'scripts/qa/d2-browser-security-evidence.js'
  ];

  return [
    info('Existing D2 QA scripts found', {
      backend: expectedBackendScripts.map((script) => ({ script, exists: exists(script) })),
      frontend: expectedFrontendScripts.map((script) => ({ script, exists: exists(script, FRONTEND_ROOT) }))
    })
  ];
}

function summarize(checks) {
  return checks.reduce((summary, item) => {
    summary.total += 1;
    if (item.ok) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
      summary.bySeverity[item.severity] = (summary.bySeverity[item.severity] || 0) + 1;
    }
    return summary;
  }, {
    total: 0,
    passed: 0,
    failed: 0,
    bySeverity: {}
  });
}

function run() {
  const checks = [
    ...auditCookieConfig(),
    ...auditCsrf(),
    ...auditCors(),
    ...auditRoutes(),
    ...auditSuperAdminIsolation(),
    ...auditBackendPermissions(),
    ...auditFrontendD2(),
    ...auditSecurityHeaders(),
    ...auditSecretsAndEnv(),
    ...auditExistingQaCoverage()
  ];
  const summary = summarize(checks);

  return {
    ok: summary.failed === 0,
    script: 'security-auth-cookies-whitebox-audit',
    scope: {
      backendRoot: ROOT,
      frontendRoot: FRONTEND_ROOT,
      dbAccess: false,
      externalTargets: false,
      secretsPrinted: false
    },
    summary,
    checks
  };
}

function main() {
  const result = run();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main();

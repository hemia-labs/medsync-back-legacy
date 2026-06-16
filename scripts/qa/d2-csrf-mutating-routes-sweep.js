'use strict';

require('../../src/config/env');

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const AuthCookieConfig = require('../../src/config/authCookie.config');
const CsrfTokenService = require('../../src/services/security/csrfToken.service');
const { csrfProtection } = require('../../src/middleware/csrf.middleware');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const ROUTES_ROOT = path.join(PROJECT_ROOT, 'src/routes/mysql');
const QA_CSRF_SECRET = 'QA_D2_3B_CSRF_SECRET_0123456789_abcdefghijklmnopqrstuvwxyz';
const ALLOWED_ORIGIN = 'https://app.example.test';
const USER_AGENT = 'QA_D2_3B_CSRF_MUTATING_ROUTES_SWEEP';

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
  'CSRF_TOKEN_TTL_SECONDS',
  'CSRF_ORIGIN_CHECK_ENABLED',
  'CSRF_ALLOWED_ORIGINS',
  'CORS_CREDENTIALS',
  'CORS_ALLOWED_ORIGINS',
  'CORS_ORIGIN',
  'NODE_ENV',
  'APP_ENV',
  'ENVIRONMENT',
  'REQUIRE_ACTIVE_SESSION'
];

const ROUTE_PREFIXES = {
  'appointment.js': '/api/appointment',
  'auth.js': '/api/auth',
  'business.js': '/api/business',
  'clinical-history.js': '/api/clinical-history',
  'clinical-history-template.js': '/api/clinical-history-template',
  'config.js': '/api/config',
  'document.js': '/api/document',
  'file.js': '/api/file',
  'odontogram.js': '/api/odontogram',
  'prescription.js': '/api/prescription',
  'public-document-signature.js': '/api/public/document-signature',
  'px.js': '/api/px',
  'rol.js': '/api/rol',
  'super-admin.js': '/api/super-admin',
  'tracing.js': '/api/tracing',
  'treatment.js': '/api/treatment',
  'user.js': '/api/user'
};

const EXPECTED_D2_3A_AUTH_ROUTES = [
  { method: 'post', path: '/login' },
  { method: 'put', path: '/close' },
  { method: 'post', path: '/refreshToken' },
  { method: 'post', path: '/sendOtp' },
  { method: 'post', path: '/validateOtp' },
  { method: 'put', path: '/resetPassword' }
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
  Object.keys(overrides || {}).forEach((key) => {
    process.env[key] = overrides[key];
  });
}

function d2Env(overrides) {
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
    CSRF_TOKEN_SECRET: QA_CSRF_SECRET,
    CSRF_HEADER_NAME: 'X-CSRF-Token',
    CSRF_TOKEN_TTL_SECONDS: '900',
    CSRF_ORIGIN_CHECK_ENABLED: 'true',
    CSRF_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    CORS_CREDENTIALS: 'true',
    CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN
  }, overrides || {});
}

function legacyEnv(overrides) {
  return Object.assign({
    NODE_ENV: 'development',
    REQUIRE_ACTIVE_SESSION: 'true',
    AUTH_COOKIE_MODE: 'legacy',
    BROWSER_AUTH_TRANSPORT: 'authorization',
    CSRF_ENABLED: 'false'
  }, overrides || {});
}

async function withEnv(env, fn) {
  const snapshot = snapshotEnv();
  const originalInfo = console.info;
  try {
    setEnv(env);
    console.info = function noop() {};
    return await fn();
  } finally {
    console.info = originalInfo;
    restoreEnv(snapshot);
  }
}

function listRouteFiles() {
  return fs.readdirSync(ROUTES_ROOT)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(ROUTES_ROOT, name));
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function routeType(fileName) {
  if (fileName === 'auth.js') return 'auth';
  if (fileName === 'super-admin.js') return 'super-admin';
  if (fileName === 'public-document-signature.js') return 'publico por token';
  if (['business.js', 'config.js', 'rol.js', 'user.js'].includes(fileName)) return 'tenant/admin';
  if ([
    'appointment.js',
    'clinical-history.js',
    'clinical-history-template.js',
    'document.js',
    'file.js',
    'odontogram.js',
    'prescription.js',
    'px.js',
    'tracing.js',
    'treatment.js'
  ].includes(fileName)) return 'clinico';
  return 'sistema/desconocido';
}

function routeAuth(line, fileName) {
  if (line.includes('Token.Auth')) return 'Token.Auth';
  if (line.includes('Token.OptionalAuth')) return 'Token.OptionalAuth';
  if (fileName === 'public-document-signature.js') return 'token publico';
  return 'publica/desconocida';
}

function routeDecision(route) {
  if (route.fileName === 'public-document-signature.js') {
    return {
      decision: 'excluir por publica/token',
      reason: 'Ruta publica por token; D2-3B no mezcla firma publica ni webhooks/callbacks.'
    };
  }

  if (route.fileName === 'auth.js' && route.hasCsrfAuthEndpoint) {
    return {
      decision: route.localPath === '/forze-close' ? 'proteger con CSRF en D2-3B' : 'ya protegida en D2-3A',
      reason: route.localPath === '/forze-close'
        ? 'Mutacion auth-like autenticada; revisada explicitamente y protegida.'
        : 'Endpoint auth/pre-auth ya cubierto por foundation D2-3A.'
    };
  }

  if (route.auth === 'Token.Auth' && route.hasCsrfProtected) {
    return {
      decision: 'proteger con CSRF en D2-3B',
      reason: 'Mutacion autenticada por sesion que puede recibir cookies D2.'
    };
  }

  if (route.auth === 'Token.OptionalAuth' && route.hasCsrfAuthEndpoint) {
    return {
      decision: 'ya protegida en D2-3A',
      reason: 'Mutacion auth con OptionalAuth cubierta por middleware CSRF auth.'
    };
  }

  return {
    decision: 'pendiente decision',
    reason: 'Ruta mutante sin clasificacion CSRF segura.'
  };
}

function apiPath(fileName, localPath) {
  return `${ROUTE_PREFIXES[fileName] || `/api/${fileName.replace(/\.js$/, '')}`}${localPath}`;
}

function middlewareSummary(line) {
  return String(line || '')
    .replace(/^.*router\.\w+\(\s*['"][^'"]+['"]\s*,\s*/, '')
    .replace(/awaitHandlerFactory\(.*$/, 'controller)')
    .trim();
}

function inventoryRoutes() {
  const routes = [];
  const routePattern = /router\.(post|put|patch|delete)\(\s*['"]([^'"]+)['"]\s*,/i;

  listRouteFiles().forEach((filePath) => {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath, 'utf8');

    source.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(routePattern);
      if (!match) {
        return;
      }

      const route = {
        method: match[1].toLowerCase(),
        localPath: match[2],
        apiPath: apiPath(fileName, match[2]),
        fileName,
        file: normalizeSlashes(path.relative(PROJECT_ROOT, filePath)),
        line: index + 1,
        middleware: middlewareSummary(line),
        auth: routeAuth(line, fileName),
        type: routeType(fileName),
        hasCsrfProtected: line.includes('csrfProtected'),
        hasCsrfAuthEndpoint: line.includes('csrfAuthEndpoint'),
        sourceHasTokenAuth: line.includes('Token.Auth'),
        sourceHasOptionalAuth: line.includes('Token.OptionalAuth')
      };

      Object.assign(route, routeDecision(route));
      routes.push(route);
    });
  });

  return routes;
}

function countBy(routes, key) {
  return routes.reduce((counts, route) => {
    const value = route[key] || 'N/A';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function summarizeInventory(routes) {
  return {
    totalMutatingRoutes: routes.length,
    protectedByD23b: routes.filter((route) => route.decision === 'proteger con CSRF en D2-3B').length,
    coveredByD23a: routes.filter((route) => route.decision === 'ya protegida en D2-3A').length,
    excludedPublicToken: routes.filter((route) => route.decision === 'excluir por publica/token').length,
    pendingDecision: routes.filter((route) => route.decision === 'pendiente decision').length,
    byType: countBy(routes, 'type'),
    byAuth: countBy(routes, 'auth'),
    byDecision: countBy(routes, 'decision')
  };
}

function routeView(route) {
  return {
    method: route.method.toUpperCase(),
    route: route.apiPath,
    file: route.file,
    line: route.line,
    auth: route.auth,
    type: route.type,
    decision: route.decision,
    reason: route.reason
  };
}

function findRoute(routes, fileName, method, localPath) {
  return routes.find((route) => (
    route.fileName === fileName &&
    route.method === String(method).toLowerCase() &&
    route.localPath === localPath
  ));
}

function gitDiffNames() {
  try {
    return childProcess.execFileSync('git', ['diff', '--name-only'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split(/\r?\n/)
      .map((item) => normalizeSlashes(item.trim()))
      .filter(Boolean);
  } catch (error) {
    return null;
  }
}

function runtimeCorsDiffFiles() {
  const diffNames = gitDiffNames();
  if (!diffNames) {
    return null;
  }

  return diffNames.filter((file) => (
    file === 'src/index.js' ||
    file === 'src/config/security.js' ||
    file === 'src/config/authCookie.config.js' ||
    /^src\/middleware\/cors/i.test(file) ||
    /^src\/config\/cors/i.test(file)
  ));
}

function isAllowedD24CorsRuntimeFile(file) {
  return [
    'src/index.js',
    'src/config/security.js',
    'src/config/authCookie.config.js'
  ].includes(file) || /^src\/middleware\/cors/i.test(file) || /^src\/config\/cors/i.test(file);
}

function createReq(options = {}) {
  const headers = Object.assign({}, options.headers || {});
  return {
    body: Object.assign({}, options.body || {}),
    headers,
    cookies: Object.assign({}, options.cookies || {}),
    tokenDecode: options.tokenDecode || null,
    ip: '127.0.0.1',
    method: options.method || 'GET',
    url: options.url || '/qa/d2/csrf-mutating-routes-sweep',
    originalUrl: options.url || '/qa/d2/csrf-mutating-routes-sweep',
    get(name) {
      const lower = String(name || '').toLowerCase();
      if (lower === 'user-agent') {
        return USER_AGENT;
      }
      const key = Object.keys(headers).find((item) => String(item).toLowerCase() === lower);
      return key ? headers[key] : null;
    }
  };
}

function createRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    }
  };
}

function runCsrfMiddleware(reqOptions = {}) {
  const req = createReq(reqOptions);
  const res = createRes();
  const middleware = csrfProtection();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  return {
    status: res.statusCode || (nextCalled ? 200 : null),
    payload: res.payload,
    nextCalled,
    csrfContext: req.csrf ? req.csrf.contextType : null
  };
}

function headersWithCsrf(token) {
  return {
    origin: ALLOWED_ORIGIN,
    'x-csrf-token': token
  };
}

function sessionContext() {
  return {
    id_login: 'QA_D2_3B_CSRF_USER',
    id_session: 'QA_D2_3B_CSRF_SESSION',
    id_business: 'QA_D2_3B_CSRF_BUSINESS',
    email: 'qa.d2.3b.csrf@example.test',
    rol: 'super_admin'
  };
}

function pass(name, detail) {
  return { name, ok: true, detail: detail || null };
}

function fail(name, detail) {
  return { name, ok: false, detail: detail || null };
}

async function validate() {
  const checks = [];
  const routes = inventoryRoutes();
  const summary = summarizeInventory(routes);

  const protectedOutsideAuthMissing = routes.filter((route) => (
    route.fileName !== 'auth.js' &&
    route.auth === 'Token.Auth' &&
    !route.hasCsrfProtected
  ));
  checks.push(
    summary.totalMutatingRoutes > 0 && summary.protectedByD23b > 0
      ? pass('Inventory detects protected mutating routes', summary)
      : fail('Inventory detects protected mutating routes', summary)
  );

  checks.push(
    protectedOutsideAuthMissing.length === 0
      ? pass('All Token.Auth mutating routes outside auth have csrfProtected', {
        checkedRoutes: routes.filter((route) => route.fileName !== 'auth.js' && route.auth === 'Token.Auth').length
      })
      : fail('All Token.Auth mutating routes outside auth have csrfProtected', protectedOutsideAuthMissing.map(routeView))
  );

  const d23aMissing = EXPECTED_D2_3A_AUTH_ROUTES
    .map((expected) => findRoute(routes, 'auth.js', expected.method, expected.path))
    .filter((route) => !route || !route.hasCsrfAuthEndpoint);
  checks.push(
    d23aMissing.length === 0
      ? pass('Auth mutating routes from D2-3A remain covered', {
        routes: EXPECTED_D2_3A_AUTH_ROUTES.map((route) => `${route.method.toUpperCase()} /api/auth${route.path}`)
      })
      : fail('Auth mutating routes from D2-3A remain covered', d23aMissing)
  );

  const forzeClose = findRoute(routes, 'auth.js', 'put', '/forze-close');
  checks.push(
    forzeClose && forzeClose.hasCsrfAuthEndpoint
      ? pass('forze-close reviewed and protected with CSRF', routeView(forzeClose))
      : fail('forze-close reviewed and protected with CSRF', forzeClose ? routeView(forzeClose) : null)
  );

  const superAdminClose = findRoute(routes, 'super-admin.js', 'patch', '/sessions/:id/close');
  const superAdminCloseMassive = findRoute(routes, 'super-admin.js', 'patch', '/users/:id/close-sessions');
  checks.push(
    superAdminClose && superAdminClose.hasCsrfProtected &&
    superAdminCloseMassive && superAdminCloseMassive.hasCsrfProtected
      ? pass('Super Admin session close individual/massive protected', [
        routeView(superAdminClose),
        routeView(superAdminCloseMassive)
      ])
      : fail('Super Admin session close individual/massive protected', [
        superAdminClose ? routeView(superAdminClose) : null,
        superAdminCloseMassive ? routeView(superAdminCloseMassive) : null
      ])
  );

  const publicSignatureSign = findRoute(routes, 'public-document-signature.js', 'post', '/:token/sign');
  checks.push(
    publicSignatureSign &&
    publicSignatureSign.decision === 'excluir por publica/token' &&
    !publicSignatureSign.hasCsrfProtected &&
    !publicSignatureSign.hasCsrfAuthEndpoint
      ? pass('Public document signature token route excluded', routeView(publicSignatureSign))
      : fail('Public document signature token route excluded', publicSignatureSign ? routeView(publicSignatureSign) : null)
  );

  const pending = routes.filter((route) => route.decision === 'pendiente decision');
  checks.push(
    pending.length === 0
      ? pass('No pending ambiguous mutating routes in sweep inventory', { pendingDecision: 0 })
      : fail('No pending ambiguous mutating routes in sweep inventory', pending.map(routeView))
  );

  const corsRuntimeFiles = runtimeCorsDiffFiles();
  checks.push(
    Array.isArray(corsRuntimeFiles) && corsRuntimeFiles.every(isAllowedD24CorsRuntimeFile)
      ? pass('CORS runtime diff limited to D2-4 allowed files', {
        checkedGitDiff: true,
        runtimeCorsFiles: corsRuntimeFiles
      })
      : fail('CORS runtime diff limited to D2-4 allowed files', {
        checkedGitDiff: Boolean(corsRuntimeFiles),
        runtimeCorsFiles: corsRuntimeFiles
      })
  );

  await withEnv(d2Env(), async () => {
    const names = AuthCookieConfig.getCookieNames(AuthCookieConfig.getAuthCookieConfig());
    const session = sessionContext();
    const sweepUrl = '/api/super-admin/sessions/QA_D2_3B_SESSION/close';

    const missing = runCsrfMiddleware({
      method: 'PATCH',
      url: sweepUrl,
      tokenDecode: session,
      headers: { origin: ALLOWED_ORIGIN }
    });
    checks.push(
      missing.status === 403 && !missing.nextCalled
        ? pass('CSRF negative on protected sweep route returns 403', {
          route: sweepUrl,
          method: 'PATCH',
          status: missing.status,
          reason: missing.payload ? missing.payload.reason : null
        })
        : fail('CSRF negative on protected sweep route returns 403', missing)
    );

    const issueReq = createReq({
      method: 'PATCH',
      url: sweepUrl,
      tokenDecode: session,
      headers: { origin: ALLOWED_ORIGIN }
    });
    const token = CsrfTokenService.issueToken(issueReq).token;
    const valid = runCsrfMiddleware({
      method: 'PATCH',
      url: sweepUrl,
      tokenDecode: session,
      headers: headersWithCsrf(token),
      cookies: { [names.csrf]: token }
    });
    checks.push(
      valid.status === 200 && valid.nextCalled && valid.csrfContext === 'session'
        ? pass('CSRF positive on protected sweep route reaches next middleware', {
          route: sweepUrl,
          method: 'PATCH',
          status: valid.status,
          context: valid.csrfContext,
          csrfToken: CsrfTokenService.safeTokenSummary(token)
        })
        : fail('CSRF positive on protected sweep route reaches next middleware', valid)
    );
  });

  await withEnv(legacyEnv(), async () => {
    const legacyNoCsrf = runCsrfMiddleware({
      method: 'PATCH',
      url: '/api/super-admin/sessions/QA_D2_3B_SESSION/close',
      tokenDecode: sessionContext()
    });
    checks.push(
      legacyNoCsrf.status === 200 && legacyNoCsrf.nextCalled
        ? pass('Legacy with CSRF_ENABLED=false remains intact', { status: legacyNoCsrf.status })
        : fail('Legacy with CSRF_ENABLED=false remains intact', legacyNoCsrf)
    );
  });

  return {
    ok: checks.every((check) => check.ok),
    mode: 'csrf mutating routes sweep',
    dbAccess: false,
    fixtures: 'in-memory/mock only',
    cleanupRequired: false,
    secretsPrinted: false,
    csrfTokensPrinted: false,
    cookiesPrinted: false,
    authTokensPrinted: false,
    summary,
    excludedRoutes: routes
      .filter((route) => route.decision === 'excluir por publica/token')
      .map(routeView),
    checks
  };
}

function status() {
  const routes = inventoryRoutes();
  const summary = summarizeInventory(routes);
  return {
    ok: true,
    script: 'd2-csrf-mutating-routes-sweep',
    dbAccess: false,
    fixtures: 'in-memory/mock only',
    cleanupRequired: false,
    commands: ['status', 'validate', 'full'],
    requiredEnvForRuntime: [
      'CSRF_ENABLED=true',
      'CSRF_TOKEN_SECRET',
      'CSRF_HEADER_NAME=X-CSRF-Token',
      'CSRF_ALLOWED_ORIGINS=<exact origins>'
    ],
    summary,
    sampleProtectedRoutes: routes
      .filter((route) => route.decision === 'proteger con CSRF en D2-3B')
      .slice(0, 8)
      .map(routeView),
    excludedRoutes: routes
      .filter((route) => route.decision === 'excluir por publica/token')
      .map(routeView),
    secretsPrinted: false,
    csrfTokensPrinted: false,
    cookiesPrinted: false,
    authTokensPrinted: false
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

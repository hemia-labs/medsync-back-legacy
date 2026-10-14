const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const cookies = require('cookie-parser');
const jwt = require('jsonwebtoken');
const responseData = require('../../src/util/responsedata');
const root = path.resolve(__dirname, '../..');
const stub = (file, exports) => { require.cache[require.resolve(path.join(root, file))] = { exports }; };
const secret = 's18-isolated-http-fixture-not-a-deployment-secret';
let cookieMode = false;
let queries = 0;
let db;
let sessionAvailable = true;
let sessionCalls = 0;
let refreshCalls = 0;
const themeTenants = [];
const reset = () => { db = { active: true, roleActive: true, sessionActive: true, last: true,
  login: 'qa-login', session: 'qa-session', business: 'qa-business', role: 'doctor', permission: true }; };
stub('src/db/Sequelize.connection.js', { query: async (sql, options) => {
  queries += 1;
  assert.equal(options.replacements.login, 'qa-login');
  if(!db.active || !db.roleActive || !db.sessionActive || !db.last || options.replacements.session !== db.session) return [];
  return [{ id_login: db.login, id_session: db.session, id_business: db.business, id_rol: 'role-' + db.role, rol: db.role, role_name: db.role }];
} });
stub('src/config/jwt.js', { key: secret, expiresIn: { expiresIn: '10m' } });
stub('src/config/authCookie.config.js', {
  getAuthCookieConfig: () => ({ isCookieAuthEnabled: cookieMode }), assertAuthCookieConfig: () => ({}),
  getCookieNames: () => ({ access: 'qa_access', refresh: 'qa_refresh', csrf: 'qa_csrf' }),
  getAccessCookieOptions: () => ({ httpOnly: true }), getRefreshCookieOptions: () => ({ httpOnly: true }),
  getClearAccessCookieOptions: () => ({ maxAge: 0 }), getClearRefreshCookieOptions: () => ({ maxAge: 0 }),
  getClearCsrfCookieOptions: () => ({ maxAge: 0 })
});
stub('src/Dao/mysql/user.dao.js', { hasPermission: async () => db.permission });
stub('src/services/security/securityLogger.service.js', { record: () => {} });
stub('src/Dao/mysql/config.dao.js', { theme_get: async business => {
  themeTenants.push(business);
  return responseData.success([{ code: business === 'default-business' ? 'public-fixture' : 'tenant-fixture' }]);
} });
stub('src/Dao/mysql/auth.dao.js', {
  session: async body => {
    sessionCalls += 1;
    assert.equal(body.id_login, db.login); assert.equal(body.id_session, db.session);
    return sessionAvailable ? responseData.success({ token: jwt.sign({ id_login: db.login, id_session: db.session,
      id_business: db.business, rol: db.role }, secret), permisos: ['clinical_history.view'] }) : responseData.notSuccess('Inactive fixture');
  },
  refreshToken: async body => {
    refreshCalls += 1;
    if(!body || body.id_refresh_token !== 'synthetic-owner-b-refresh') return responseData.unauthorized('Invalid refresh fixture');
    // A simulated refresh DAO chooses the owner of the supplied refresh token;
    // expired access claims must never become the identity of the new session.
    return responseData.success({ token: jwt.sign({ id_login: 'owner-b', id_session: 'session-b',
      id_business: 'business-b', rol: 'doctor' }, secret), refresh_token: 'synthetic-owner-b-rotated', permisos: [] });
  }
});
const Token = require('../../src/auth/authenticate');
const AuthController = require('../../src/controller/mysql/auth.controller');
const ConfigController = require('../../src/controller/mysql/config.controller');
const requireRole = require('../../src/middleware/requireRole.middleware');
const { requirePermission } = require('../../src/middleware/requirePermission.middleware');
const app = express();
app.use(cookies());
app.use(express.json());
app.get('/protected', Token.Auth, (req, res) => res.json({ role: req.tokenDecode.rol, tenant: req.tokenDecode.id_business }));
app.get('/admin', Token.Auth, requireRole('admin'), (req, res) => res.json({ allowed: true }));
app.get('/permission', Token.Auth, requirePermission('clinical_history.view'), (req, res) => res.json({ allowed: true }));
app.get('/optional', Token.OptionalAuth, (req, res) => res.json({ invalid: req.authTokenInvalid, authenticated: Boolean(req.tokenDecode) }));
app.get('/session', Token.OptionalAuth, AuthController.session);
app.get('/theme', Token.OptionalAuth, ConfigController.themeGet);
app.get('/missing-session-claims', (req, res) => AuthController.session({ tokenDecode: { id_login: 'qa-login' } }, res));
app.post('/refresh', Token.OptionalAuth, (req, res, next) => {
  assert.equal(req.tokenDecode, undefined, 'Expired or absent access claims cannot become a refresh principal');
  next();
}, AuthController.refreshToken);
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));

(async () => {
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const claims = { id_login: 'qa-login', id_session: 'qa-session', id_business: 'qa-business', rol: 'admin', id_rol: 'old-admin-role' };
    const token = Token.GetAccessToken(claims).token;
    const request = async (route, credential = token, refreshCookie = '', body) => {
      const authHeaders = cookieMode ? { Cookie: [credential && `qa_access=${credential}`, refreshCookie && `qa_refresh=${refreshCookie}`].filter(Boolean).join('; ') }
        : credential ? { Authorization: `Bearer ${credential}` } : {};
      const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { ...authHeaders,
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
    };
    for(const mode of [false, true]) {
      cookieMode = mode; reset();
      const before = queries;
      const valid = await request('/protected');
      assert.equal(valid.status, 200); assert.equal(valid.body.role, 'doctor', 'Live role replaces stale admin JWT');
      assert.equal(queries - before, 1, 'One bounded principal query per authenticated request');
      const themed = await request('/theme');
      assert.equal(themed.status, 200); assert.equal(themed.body.data[0].code, 'tenant-fixture');
      assert.equal(themeTenants[themeTenants.length - 1], 'qa-business', 'Valid theme request is scoped to the current principal');
      assert.equal((await request('/admin')).status, 403, 'Old administrator token cannot keep its old role');
      assert.equal((await request('/permission')).status, 200);
      db.permission = false;
      assert.equal((await request('/permission')).status, 403, 'Revoked module permission denies immediately');
      db.role = 'admin';
      assert.equal((await request('/admin')).status, 200, 'Current authorized role remains functional');
      for(const field of ['active', 'roleActive', 'sessionActive', 'last']) {
        reset(); db[field] = false;
        const denied = await request('/protected');
        assert.equal(denied.status, 401, field); assert.equal(denied.body.data.code, 'AUTH_SESSION_INVALID');
        const optional = await request('/optional'); assert.equal(optional.body.authenticated, false); assert.equal(optional.body.invalid, true);
        const beforeDeniedTheme = themeTenants.length;
        const revokedTheme = await request('/theme');
        assert.equal(revokedTheme.status, 401); assert.equal(revokedTheme.body.data.code, 'AUTH_SESSION_INVALID');
        assert.equal(themeTenants.length, beforeDeniedTheme, 'A revoked session never queries the public theme');
      }
      reset(); db.business = 'other-business'; assert.equal((await request('/protected')).status, 401, 'Tenant change requires new session');
      reset(); db.session = 'replacement-session'; assert.equal((await request('/protected')).status, 401, 'Closed/replaced session cannot be replayed');
      reset(); assert.equal((await request('/protected', jwt.sign({ ...claims, id_session: undefined }, secret))).status, 401);
      const expired = jwt.sign(claims, secret, { expiresIn: -1 });
      const beforeExpiredQueries = queries, beforeExpiredSession = sessionCalls;
      const beforeExpiredTheme = themeTenants.length;
      for(const route of ['/protected', '/session', '/theme']) {
        const result = await request(route, expired, 'synthetic-owner-b-refresh');
        assert.equal(result.status, 401); assert.equal(result.body.data.code, 'AUTH_ACCESS_EXPIRED');
        assert.equal(result.cookies.length, 0, 'Expired access preserves cookies for an explicitly validated refresh attempt');
      }
      assert.equal(queries, beforeExpiredQueries, 'Expired JWT does not query a trusted principal');
      assert.equal(sessionCalls, beforeExpiredSession, 'Expired JWT never invokes authenticated session hydration');
      assert.equal(themeTenants.length, beforeExpiredTheme, 'Expired access never falls back to the public theme');
      assert.equal((await request('/protected', 'corrupt-token')).body.data.code, 'AUTH_ACCESS_INVALID');
      const corrupt = await request('/session', 'corrupt-token', 'synthetic-owner-b-refresh');
      assert.equal(corrupt.status, 401); assert.equal(corrupt.body.data.code, 'AUTH_ACCESS_INVALID');
      assert.equal(corrupt.cookies.length, mode ? 3 : 0, 'Corrupt JWT is terminal, even with a refresh cookie');
      const corruptTheme = await request('/theme', 'corrupt-token', 'synthetic-owner-b-refresh');
      assert.equal(corruptTheme.status, 401); assert.equal(corruptTheme.body.data.code, 'AUTH_ACCESS_INVALID');
      assert.equal(themeTenants.length, beforeExpiredTheme, 'Corrupt access does not query another theme');
      const missing = await request('/session', jwt.sign({ ...claims, id_session: undefined }, secret));
      assert.equal(missing.body.data.code, 'AUTH_SESSION_INVALID');
      const missingControllerClaims = await request('/missing-session-claims', '');
      assert.equal(missingControllerClaims.body.data.code, 'AUTH_SESSION_INVALID');
      const sessionOk = await request('/session'); assert.equal(sessionOk.status, 200); assert.equal(sessionOk.body.data.authenticated, true);
      sessionAvailable = false;
      assert.equal((await request('/session')).body.data.code, 'AUTH_SESSION_INVALID', 'A session revoked between middleware and DAO stays terminal');
      sessionAvailable = true;
      const refreshed = await request('/refresh', expired, 'synthetic-owner-b-refresh', {
        id_refresh_token: mode ? 'attacker-body-refresh' : 'synthetic-owner-b-refresh',
        id_login: 'injected-owner', id_business: 'injected-tenant', rol: 'super_admin'
      });
      assert.equal(refreshed.status, 200);
      const refreshedIdentity = mode ? refreshed.body.data.user : jwt.decode(refreshed.body.data.token);
      assert.equal(refreshedIdentity.id_login, 'owner-b'); assert.equal(refreshedIdentity.id_business, 'business-b');
      assert.equal(refreshedIdentity.rol, 'doctor', 'New identity comes solely from the refresh DAO response');
      const rejectedRefresh = await request('/refresh', expired, 'invalid-refresh', { id_refresh_token: 'invalid-refresh' });
      assert.equal(rejectedRefresh.status, 401, 'Presence of a refresh token never proves authorization');
      if(mode) {
        const beforeMissingAccess = refreshCalls;
        for(const route of ['/protected', '/session', '/theme']) {
          const withoutAccess = await request(route, '', 'invalid-refresh');
          assert.equal(withoutAccess.status, 401); assert.equal(withoutAccess.body.data.code, 'AUTH_ACCESS_EXPIRED');
          assert.equal(withoutAccess.cookies.length, 0);
        }
        assert.equal(refreshCalls, beforeMissingAccess, 'Missing access only asks the client to try renewal; it does not renew automatically');
        assert.equal(themeTenants.length, beforeExpiredTheme, 'A refresh cookie cannot cause an anonymous theme response');
      }
      assert.equal((await request('/protected', '')).status, 401);
      const anonymous = await request('/optional', ''); assert.equal(anonymous.body.authenticated, false); assert.equal(anonymous.body.invalid, false);
      const publicTheme = await request('/theme', '');
      assert.equal(publicTheme.status, 200); assert.equal(publicTheme.body.data[0].code, 'public-fixture');
      assert.equal(themeTenants[themeTenants.length - 1], 'default-business', 'Login without credentials retains public branding');
    }
    console.log('PASS S18 HTTP: real Express/JWT/controller, D2 cookie + legacy bearer, live authorization, revoked sessions, tenant changes, expiry versus invalid credentials, cookie preservation, refresh owner isolation, missing access with refresh and tenant/public theme isolation. Simulated DAOs/DB; no real DB connections.');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

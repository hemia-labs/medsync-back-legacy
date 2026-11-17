'use strict';
// NC1-AUTH-S1-S3 (contract §7 of PHASE_NC1_401_HANDLER_CONTRACT_ANALYSIS_CLAUDE_20261116.md).
//   S1: an authentication 401 on a protected/business route carries an AUTH_* code in the serialized response
//       (canonical data.code); missing actor → AUTH_ACCESS_INVALID, missing/revoked session → AUTH_SESSION_INVALID.
//   S2: valid session without business → 403 BUSINESS_CONTEXT_REQUIRED; insufficient permission → 403 PERMISSION_DENIED.
//   S3: inventory of every 401 emitter (helpers, aliases, literal statuses, errors carrying status, serializers) with
//       an explicit, justified allowlist for auth/* controls; negatives prove a new codeless 401 is detected.
// No MySQL, no network, no live suites: real modules with stubbed collaborators and in-memory Express routes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const root = path.resolve(__dirname, '../..');
const results = [];
const failures = [];
// Every group runs and reports; any failure sets a non-zero exit code.
const test = async (name, fn) => { try { await fn(); results.push(name); console.log('PASS ' + name); } catch (error) { failures.push(name); process.exitCode = 1; console.log('FAIL ' + name + '\n     ' + String(error && error.message).split('\n').slice(0, 4).join('\n     ')); } };
const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const AUTH_CODES = ['AUTH_ACCESS_INVALID', 'AUTH_ACCESS_EXPIRED', 'AUTH_SESSION_INVALID'];

// ---------------------------------------------------------------- S3 inventory scanner
// A line is a 401 emitter when it uses the helper, an alias of the status, a literal 401 status or an error
// carrying status 401. It is compliant when the same statement names an AUTH_* code (or forwards a code
// variable, for serializers). Everything else must be an allowlisted auth/* control or helper definition.
const EMITTER = /\bunauthorized\s*\(|HttpStatus\.UNAUTHORIZED|HttpNotAutorized\s*\(|\bstatus\s*\(\s*401\s*\)|\bstatus\s*:\s*401\b|[sS]tatus(?:Code)?\s*={2,3}\s*401|\[[^\]]*\b401\b[^\]]*\]\.includes/;
const COMPLIANT = /code\s*:\s*'AUTH_(ACCESS_INVALID|ACCESS_EXPIRED|SESSION_INVALID)'|\{\s*code\s*\}|authCode\(|AUTH_CODE/;
const ALLOW = [
    // Helper and constant definitions (they do not choose a status for a request).
    { file: 'src/util/responsedata.js', snippet: 'function unauthorized(', count: 1, reason: 'helper definition' },
    { file: 'src/util/responsedata.js', snippet: 'status: HttpStatus.UNAUTHORIZED', count: 1, reason: 'helper body' },
    // auth/* controls keep their own contract (contract §7.2); the client classifies api/auth/* as control requests.
    { file: 'src/controller/mysql/auth.controller.js', snippet: 'responseData.unauthorized(GENERIC_REFRESH_ERROR)', count: 2, reason: 'POST auth/refreshToken: the refresh action owns a failed renewal' },
    { file: 'src/controller/mysql/auth.controller.js', snippet: 'this.HttpNotAutorized(HttpStatus.UNAUTHORIZED, MESSAGES.NOT_CONTENT)', count: 2, reason: 'POST auth/close and auth/forze_close: logout controls, default response before the DAO answers' },
    { file: 'src/Dao/mysql/auth.dao.js', snippet: 'responseData.unauthorized(Messages.AUTH_NOT_FOUND)', count: 3, reason: 'auth/login, auth/refreshToken and auth/session internals; auth/session re-maps to AUTH_SESSION_INVALID' },
    { file: 'src/Dao/mysql/auth.dao.js', snippet: "responseData.unauthorized('La sesion no es valida.')", count: 2, reason: 'auth/changePassword/{sendCode,confirm}: behind Token.Auth, unreachable without an actor' },
    { file: 'src/Dao/mysql/auth.dao.js', snippet: "responseData.unauthorized('La cuenta de la sesion ya no esta activa.')", count: 2, reason: 'auth/changePassword/{sendCode,confirm}: auth/* control, owned by its screen' },
    // Documented registration contract: root code, preserves upstream AUTH_* and only falls back for an uncoded 401.
    { file: 'src/routes/mysql/registration.js', snippet: "this.statusCode===401?'AUTH_REQUIRED'", count: 1, reason: 'registration/activation serializer; keeps body.code/body.data.code from Token.Auth' },
    // Pulso serializer: maps the error status; the following statement forwards error.code to data.code (envelope test below).
    { file: 'src/controller/mysql/businessPulse.controller.js', snippet: 'const status = [400,401,403,429,503].includes(error.status)', count: 1, reason: 'status whitelist of the Pulso serializer; code forwarded on the next statement' },
    // Not emitters: they read a received status.
    { file: 'src/services/registration/legalRegistration.service.js', snippet: 'error.status===401', count: 1, reason: 'reads an upstream status from Hemia Legal' }
];
function scan(files) {
    const findings = [], used = new Map();
    for (const { file, text } of files) {
        text.split(/\r?\n/).forEach((line, index) => {
            if (!EMITTER.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
            const allow = ALLOW.find(entry => entry.file === file && line.includes(entry.snippet));
            if (allow) { used.set(allow, (used.get(allow) || 0) + 1); return; }
            if (!COMPLIANT.test(line)) findings.push(`${file}:${index + 1}: ${line.trim().slice(0, 140)}`);
        });
    }
    return { findings, used };
}
function sourceFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (entry.name.endsWith('.js')) out.push({ file: path.relative(root, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
    }
    return out;
}

// ---------------------------------------------------------------- HTTP helper
async function call(app, method, url, { headers = {}, body } = {}) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        return await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
                let raw = ''; res.on('data', chunk => { raw += chunk; });
                res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, body: json }); });
            });
            req.on('error', reject); if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body)); req.end();
        });
    } finally { await new Promise(resolve => server.close(resolve)); }
}
const withActor = actor => (req, _res, next) => { if (actor) req.tokenDecode = { ...actor }; next(); };
const authCode = body => body && ((body.data && body.data.code) || body.code);

(async () => {
    await test('S3 inventory: every 401 emitter in src carries an AUTH_* code or is an allowlisted auth/* control', async () => {
        const { findings, used } = scan(sourceFiles(path.join(root, 'src')));
        assert.deepEqual(findings, [], 'Codeless 401 emitters:\n' + findings.join('\n'));
        for (const entry of ALLOW) assert.equal(used.get(entry) || 0, entry.count, `Allowlist entry is stale or widened: ${entry.file} «${entry.snippet}» (${entry.reason})`);
    });

    await test('S3 negatives: the scanner detects new codeless 401s in every form and accepts coded ones', async () => {
        const bad = [
            "return responseData.unauthorized('Sin acceso.');",
            "res.status(401).send({ status: 401, data: null, message: 'x' });",
            "res.status(HttpStatus.UNAUTHORIZED).send(body);",
            "throw Object.assign(Error('X'), { status: 401 });",
            "const r = this.HttpError(HttpStatus.UNAUTHORIZED, 'x');",
            "const r = httpResponseHelper.HttpNotAutorized(HttpStatus.UNAUTHORIZED, 'x');"
        ];
        for (const line of bad) assert.equal(scan([{ file: 'src/new-route.js', text: line }]).findings.length, 1, 'not detected: ' + line);
        const good = [
            "return responseData.unauthorized('Sin acceso.', { code: 'AUTH_ACCESS_INVALID' });",
            "throw Object.assign(Error('X'), { status: 401, code: 'AUTH_SESSION_INVALID' });"
        ];
        for (const line of good) assert.equal(scan([{ file: 'src/new-route.js', text: line }]).findings.length, 0, 'false positive: ' + line);
        // An allowlist entry only covers its own file: the same text elsewhere is a finding.
        assert.equal(scan([{ file: 'src/controller/mysql/other.controller.js', text: 'responseData.unauthorized(GENERIC_REFRESH_ERROR)' }]).findings.length, 1);
    });

    // ------------------------------------------------------------ S1 awaitHandlerFactory
    const security = require('../../src/config/security');
    const originalRequired = security.isActiveSessionRequired;
    let activeSession = true, sessionError = null, handled = 0;
    stub('../../src/Dao/mysql/session.Dao.js', { checkActiveSession: async () => { if (sessionError) throw sessionError; return activeSession ? { id_session: 's' } : null; } });
    stub('../../src/services/security/securityLogger.service', { record() {} });
    const awaitHandlerFactory = require('../../src/middleware/awaitHandlerFactory.middleware');
    await test('S1 awaitHandlerFactory: incomplete claims and revoked session → 401 AUTH_SESSION_INVALID; active passes; errors are not revocations', async () => {
        security.isActiveSessionRequired = () => true;
        try {
            const route = actor => { const app = express(); app.get('/x', withActor(actor), awaitHandlerFactory(async (_req, res) => { handled++; res.json({ ok: true }); })); app.use((err, _req, res, _next) => res.status(500).json({ status: 500, message: 'error' })); return app; };
            for (const actor of [{ id_login: 'qa' }, { id_session: 's' }]) {
                const r = await call(route(actor), 'GET', '/x');
                assert.equal(r.status, 401); assert.equal(r.body.data && r.body.data.code, 'AUTH_SESSION_INVALID');
            }
            activeSession = false;
            let r = await call(route({ id_login: 'qa', id_session: 's' }), 'GET', '/x');
            assert.equal(r.status, 401); assert.equal(r.body.data.code, 'AUTH_SESSION_INVALID'); assert.equal(r.body.status, 401);
            activeSession = true; handled = 0;
            r = await call(route({ id_login: 'qa', id_session: 's' }), 'GET', '/x');
            assert.equal(r.status, 200); assert.equal(handled, 1);
            sessionError = new Error('db unavailable');
            r = await call(route({ id_login: 'qa', id_session: 's' }), 'GET', '/x');
            assert.equal(r.status, 500, 'a failed check is not a revocation'); sessionError = null;
            security.isActiveSessionRequired = () => false; handled = 0;
            r = await call(route({ id_login: 'qa' }), 'GET', '/x');
            assert.equal(r.status, 200, 'the activating conditions are unchanged'); assert.equal(handled, 1);
        } finally { security.isActiveSessionRequired = originalRequired; }
    });

    // ------------------------------------------------------------ S1 middleware defenses
    const UserDao = require('../../src/Dao/mysql/user.dao');
    UserDao.hasPermission = async () => false;
    const { requirePermission } = require('../../src/middleware/requirePermission.middleware');
    const requireRole = require('../../src/middleware/requireRole.middleware');
    const { protectedBodyParser } = require('../../src/middleware/requestBody.middleware');
    await test('S1 middleware defenses: no actor → 401 AUTH_ACCESS_INVALID; with actor the 403/parse behaviour is unchanged', async () => {
        const make = (actor, mw) => { const app = express(); app.post('/api/file/px/upload-file', withActor(actor), mw, (req, res) => res.json({ ok: true, body: req.body })); return app; };
        for (const mw of [requirePermission('admin.users'), (typeof requireRole === 'function' ? requireRole : requireRole.requireRole)('admin'), protectedBodyParser]) {
            const r = await call(make(null, mw), 'POST', '/api/file/px/upload-file', { body: { a: 1 } });
            assert.equal(r.status, 401); assert.equal(r.body.data && r.body.data.code, 'AUTH_ACCESS_INVALID');
        }
        let r = await call(make({ id_login: 'qa', rol: 'doctor' }, requirePermission('admin.users')), 'POST', '/api/file/px/upload-file');
        assert.equal(r.status, 403); assert.equal(r.body.data.code, 'AUTHZ_FORBIDDEN');
        r = await call(make({ id_login: 'qa' }, protectedBodyParser), 'POST', '/api/file/px/upload-file', { body: { a: 1 } });
        assert.equal(r.status, 200); assert.deepEqual(r.body.body, { a: 1 });
        // A valid actor on a route without a protected body policy is a route configuration problem, not a session loss.
        const app = express(); app.post('/api/not-protected', withActor({ id_login: 'qa' }), protectedBodyParser, (_req, res) => res.json({ ok: true }));
        r = await call(app, 'POST', '/api/not-protected', { body: { a: 1 } });
        assert.notEqual(r.status, 401); assert.equal(r.status, 400); assert.equal(r.body.code, 'REQUEST_BODY_POLICY_UNAVAILABLE');
    });

    // ------------------------------------------------------------ S1/S2 Continuidad
    let continuityQueries = 0;
    stub('../../src/util/dashboardAccess', { resolveDashboardAccess: async () => { continuityQueries++; return { error: { status: 403, data: { code: 'DASHBOARD_FORBIDDEN' }, message: 'x' } }; }, seedDashboardPermissions: async () => {} });
    const HomeContinuityDao = require('../../src/Dao/mysql/homeContinuity.dao');
    await test('S1/S2 Continuidad: no actor → 401 AUTH_ACCESS_INVALID; actor without business → 403 BUSINESS_CONTEXT_REQUIRED; nothing read', async () => {
        let r = await HomeContinuityDao.summary('qa-clinic', null);
        assert.equal(r.status, 401); assert.equal(r.data.code, 'AUTH_ACCESS_INVALID');
        r = await HomeContinuityDao.summary(null, null);
        assert.equal(r.status, 401, 'authentication is checked first'); assert.equal(r.data.code, 'AUTH_ACCESS_INVALID');
        r = await HomeContinuityDao.summary(null, 'qa');
        assert.equal(r.status, 403); assert.equal(r.data.code, 'BUSINESS_CONTEXT_REQUIRED');
        assert.equal(continuityQueries, 0, 'denied before any read');
        r = await HomeContinuityDao.summary('qa-clinic', 'qa');
        assert.equal(r.status, 403); assert.equal(r.data.code, 'DASHBOARD_FORBIDDEN', 'existing access decision unchanged');
        assert.equal(continuityQueries, 1, 'a complete context proceeds to the access check');
    });

    // ------------------------------------------------------------ S1/S2 Pulso (service → controller → route wrapper)
    const { PulseAccess } = require('../../src/services/pulse/access');
    const { createRouter } = require('../../src/routes/mysql/business-pulse');
    const passAuth = actor => (req, _res, next) => { req.tokenDecode = actor; next(); };
    const passOperational = (_req, _res, next) => next();
    let pulseQueries = 0;
    const access = new PulseAccess({ query: async () => { pulseQueries++; return []; } });
    const service = { snapshot: async principal => { await access.authorize(principal); return { ok: true }; }, history: async () => { throw Object.assign(Error('PULSE_UNAVAILABLE'), { status: 503 }); } };
    await test('S1/S2 Pulso: AUTH code survives service, controller and route wrapper; missing business → 403 BUSINESS_CONTEXT_REQUIRED', async () => {
        const app = actor => { const a = express(); a.use('/api/business/pulse', createRouter(service, passAuth(actor), passOperational)); return a; };
        let r = await call(app({ id_login: 'qa', id_business: 'qa-clinic' }), 'GET', '/api/business/pulse/snapshot');
        assert.equal(r.status, 401); assert.equal(r.body.data && r.body.data.code, 'AUTH_SESSION_INVALID', 'canonical data.code'); assert.equal(r.body.code, 'AUTH_SESSION_INVALID', 'root code kept for compatibility');
        r = await call(app({ id_session: 's', id_business: 'qa-clinic' }), 'GET', '/api/business/pulse/snapshot');
        assert.equal(r.status, 401); assert.equal(r.body.data.code, 'AUTH_SESSION_INVALID');
        r = await call(app({ id_login: 'qa', id_session: 's' }), 'GET', '/api/business/pulse/snapshot');
        assert.equal(r.status, 403); assert.equal(r.body.data.code, 'BUSINESS_CONTEXT_REQUIRED'); assert.equal(r.body.code, 'BUSINESS_CONTEXT_REQUIRED');
        assert.equal(pulseQueries, 0, 'denied before reading');
        r = await call(app({ id_login: 'qa', id_session: 's', id_business: 'qa-clinic' }), 'GET', '/api/business/pulse/snapshot');
        assert.equal(r.status, 403, 'permissions still decide (no records → forbidden)'); assert.equal(pulseQueries, 1);
        r = await call(app({ id_login: 'qa', id_session: 's', id_business: 'qa-clinic' }), 'GET', '/api/business/pulse/history');
        assert.equal(r.status, 503); assert.equal(r.body.code, 'PULSE_UNAVAILABLE'); assert.equal(r.body.data.code, 'PULSE_UNAVAILABLE');
        // Token.Auth's own envelope keeps its code through the wrapper.
        const tokenAuth = (_req, res) => res.status(401).send({ status: 401, data: { code: 'AUTH_ACCESS_EXPIRED' }, message: 'El acceso ha vencido.' });
        const a = express(); a.use('/api/business/pulse', createRouter(service, tokenAuth, passOperational));
        r = await call(a, 'GET', '/api/business/pulse/snapshot');
        assert.equal(r.status, 401); assert.equal(r.body.data.code, 'AUTH_ACCESS_EXPIRED'); assert.equal(r.body.code, 'AUTH_ACCESS_EXPIRED');
    });

    // ------------------------------------------------------------ S2 business.updateCurrent
    let canConfig = false, businessWrites = 0;
    require('../../src/util/effectivePermissions').isTenantAdministrator = async () => canConfig;
    await test('S2 business.updateCurrent: missing admin.config → 403 PERMISSION_DENIED, nothing written; no actor → 401 AUTH_ACCESS_INVALID', async () => {
        const BusinessDao = require('../../src/Dao/mysql/business.dao');
        for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(BusinessDao)).concat(Object.keys(BusinessDao))) {
            if (typeof BusinessDao[key] === 'function' && key !== 'constructor') BusinessDao[key] = async () => { businessWrites++; return { status: 200, data: {} }; };
        }
        const controller = require('../../src/controller/mysql/business.controller');
        const app = actor => { const a = express(); a.use(express.json()); a.put('/api/business/current', withActor(actor), controller.updateCurrent); return a; };
        let r = await call(app({ id_login: 'qa', id_business: 'qa-clinic' }), 'PUT', '/api/business/current', { body: { name: 'QA' } });
        assert.equal(r.status, 403); assert.equal(r.body.data && r.body.data.code, 'PERMISSION_DENIED'); assert.equal(businessWrites, 0);
        r = await call(app(null), 'PUT', '/api/business/current', { body: { name: 'QA' } });
        assert.equal(r.status, 401); assert.equal(r.body.data.code, 'AUTH_ACCESS_INVALID'); assert.equal(businessWrites, 0);
    });

    // ------------------------------------------------------------ S2 businessDashboard
    await test('S2 businessDashboard: valid session without business → 403 BUSINESS_CONTEXT_REQUIRED before any DAO call', async () => {
        const BusinessDashboardDao = require('../../src/Dao/mysql/businessDashboard.dao');
        let daoCalls = 0;
        for (const key of Object.keys(BusinessDashboardDao).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(BusinessDashboardDao)))) {
            if (typeof BusinessDashboardDao[key] === 'function' && key !== 'constructor') BusinessDashboardDao[key] = async () => { daoCalls++; return false; };
        }
        const controller = require('../../src/controller/mysql/businessDashboard.controller');
        const handler = controller.summary || controller.getSummary || Object.values(controller).find(v => typeof v === 'function');
        const app = actor => { const a = express(); a.get('/api/business/dashboard/summary', withActor(actor), handler); return a; };
        let r = await call(app({ id_login: 'qa', id_session: 's' }), 'GET', '/api/business/dashboard/summary');
        assert.equal(r.status, 403); assert.equal(r.body.data && r.body.data.code, 'BUSINESS_CONTEXT_REQUIRED'); assert.equal(daoCalls, 0);
        r = await call(app(null), 'GET', '/api/business/dashboard/summary');
        assert.equal(r.status, 401); assert.equal(r.body.data.code, 'AUTH_ACCESS_INVALID'); assert.equal(daoCalls, 0);
    });

    console.log(failures.length ? `FAIL: ${failures.length} of ${results.length + failures.length} NC1-AUTH-S1-S3 groups.` : `PASS: ${results.length} NC1-AUTH-S1-S3 groups. No MySQL, network or live suites.`);
})().catch(error => { console.error(error); process.exitCode = 1; });

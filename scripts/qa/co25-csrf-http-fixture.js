'use strict';
// Dedicated loopback server; real CSRF controller, middleware and OptionalAuth.
// Auth/session persistence and writes are synthetic. Never load env or MySQL.
const inject = (file, value) => {
    const id = require.resolve(file);
    require.cache[id] = { id, filename: id, loaded: true, exports: value };
};
Object.assign(process.env, {
    NODE_ENV: 'test', APP_ENV: 'test', ENVIRONMENT: 'test',
    JWT_SECRET: 'co25-jwt-synthetic-only-0123456789-abcdefghijklmnopqrstuvwxyz',
    CSRF_TOKEN_SECRET: 'co25-csrf-synthetic-only-0123456789-abcdefghijklmnopqrstuvwxyz',
    AUTH_COOKIE_MODE: 'd2', BROWSER_AUTH_TRANSPORT: 'cookie', AUTH_COOKIE_SECURE: 'false',
    AUTH_COOKIE_SAMESITE: 'Lax', AUTH_COOKIE_DOMAIN: '', AUTH_COOKIE_PATH: '/', AUTH_COOKIE_MAX_AGE_MODE: 'session',
    AUTH_COOKIE_ACCESS_NAME: 'co25_at', AUTH_COOKIE_REFRESH_NAME: 'co25_rt', AUTH_CSRF_COOKIE_NAME: 'co25_csrf',
    CSRF_ENABLED: 'true', CSRF_HEADER_NAME: 'X-CSRF-Token', CSRF_TOKEN_TTL_SECONDS: '900',
    CSRF_ORIGIN_CHECK_ENABLED: 'true', CORS_CREDENTIALS: 'true'
});
inject('../../src/config/env', {});
inject('../../src/db/Sequelize.connection', { query() { throw Error('CO25 forbids DB access'); } });
inject('../../src/Dao/mysql/auth.dao', {});
inject('../../src/auth/activePrincipal', async decoded => decoded);
inject('../../src/services/security/securityLogger.service', { record() {} });
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const csrf = require('../../src/services/security/csrfToken.service');
const controller = require('../../src/controller/mysql/auth.controller');
const auth = require('../../src/auth/authenticate');
const { csrfProtection, forbidden } = require('../../src/middleware/csrf.middleware');

async function createFixture() {
    const app = express();
    const state = { csrfGets: 0, attempts: [], effects: [], held: [], holdCsrf: false, failCsrfGet: false,
        forcedReason: null, forcedRemaining: 0, refreshContexts: [], loginContexts: [], bundle: '' };
    const session = (id = 'one') => ({ id_login: 'qa-user', id_session: id, id_business: 'qa-clinic' });
    const accessCookie = (id = 'one', expiresIn = 900) => jwt.sign(session(id), process.env.JWT_SECRET, { expiresIn });
    app.use(cookieParser());
    app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><title>CO25 isolated transport QA</title><input id="draft" value="Captura sintetica"><button id="save">Guardar</button><output id="result"></output><script src="/bundle.js"></script>'));
    app.get('/bundle.js', (_req, res) => res.type('js').send(state.bundle));
    app.get('/api/auth/csrf', auth.OptionalAuth, (req, res) => {
        state.csrfGets++;
        if (state.failCsrfGet) return res.status(503).json({ message: 'Synthetic unavailable' });
        const finish = () => controller.csrf(req, res);
        if (state.holdCsrf) state.held.push(finish); else finish();
    });
    app.get('/api/auth/session', auth.OptionalAuth, (req, res) => res.json({ success: true, data: {
        authenticated: Boolean(req.tokenDecode), user: req.tokenDecode || null
    } }));
    app.post('/api/auth/refreshToken', auth.OptionalAuth, csrfProtection(), (_req, res) => {
        state.refreshContexts.push(_req.csrf.contextType);
        res.cookie('co25_at', accessCookie(), { httpOnly: true, sameSite: 'lax' });
        res.json({ success: true, data: {} });
    });
    app.post('/api/auth/login', csrfProtection(), express.json(), (req, res) => {
        state.loginContexts.push(req.csrf.contextType);
        res.cookie('co25_at', accessCookie(), { httpOnly: true, sameSite: 'lax' });
        res.json({ success: true, data: {} });
    });
    app.put('/api/auth/close', auth.Auth, csrfProtection(), (_req, res) => {
        for (const name of ['co25_at', 'co25_rt', 'co25_csrf']) res.clearCookie(name);
        res.json({ success: true, data: {} });
    });
    app.use('/api', (req, res, next) => {
        state.attempts.push({ method: req.method, url: req.originalUrl });
        if (state.forcedRemaining > 0) {
            state.forcedRemaining--;
            return res.status(403).json(state.forcedReason === 'permission'
                ? { code: 'PERMISSION_DENIED' } : forbidden(state.forcedReason));
        }
        next();
    });
    app.use('/api', auth.OptionalAuth, csrfProtection(), express.raw({ type: () => true, limit: '64kb' }), (req, res) => {
        const body = req.body.toString();
        state.effects.push({ method: req.method, url: req.originalUrl, body, key: req.get('Idempotency-Key') || null });
        if (state.dropAfterWrite) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Length', '10000');
            res.write('{');
            return setTimeout(() => res.destroy(), 20);
        }
        res.json({ success: true, data: { id: 'synthetic-saved', body } });
    });
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    process.env.CSRF_ALLOWED_ORIGINS = origin;
    process.env.CORS_ALLOWED_ORIGINS = origin;
    return { state, origin, session, accessCookie, csrf, close: () => new Promise(resolve => server.close(resolve)) };
}
module.exports = { createFixture };

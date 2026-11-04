'use strict';
const sso = require('../../auth/platformSso');
const cookies = require('../../config/authCookie.config');
const rateLimit = require('../../middleware/authRateLimit.middleware');
function createRouter(deps = {}) {
const router = require('express').Router();
const getConfig = deps.getConfig || sso.config;
const exchange = deps.exchange || sso.exchange;
const issueSession = deps.issueSession || ((c, identity, req) => require('../../auth/platformSsoSession').createSession(c, identity,
    require('../../db/Sequelize.connection'), require('../../config/jwt').key, require('../../Dao/mysql/adminAudit.dao'),
    { ip: req.ip, userAgent: req.get('user-agent') }));

router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
router.get('/config', (_req, res) => {
    let enabled = false;
    try { enabled = !!getConfig(); } catch { /* Misconfiguration never enables a fallback. */ }
    res.json({ status: 200, data: { enabled } });
});
router.get('/login', rateLimit('login'), (_req, res) => {
    try {
        const c = getConfig();
        if (!c) throw new Error('Disabled');
        const flow = sso.startFlow(c);
        res.cookie(c.flowCookie, flow.cookie, sso.flowOptions(c));
        res.redirect(303, flow.url);
    } catch { res.status(503).json({ status: 503, message: 'El acceso Hemia aún no está configurado.' }); }
});
router.get('/callback', rateLimit('login'), async (req, res) => {
    let c;
    try {
        c = getConfig();
        if (!c) throw new Error('Disabled');
        const opts = sso.flowOptions(c); delete opts.maxAge;
        res.clearCookie(c.flowCookie, opts);
        if (req.query.error || typeof req.query.code !== 'string' || req.query.code.length > 4096) throw new Error('Invalid callback');
        const flow = sso.openFlow(c, req.cookies[c.flowCookie], req.query.state);
        const identity = await exchange(c, req.query.code, flow);
        const result = await issueSession(c, identity, req);
        const names = cookies.getCookieNames(c.cookie);
        res.cookie(names.access, result.token, { ...cookies.getAccessCookieOptions(c.cookie), maxAge: result.ttl * 1000 });
        res.cookie(names.refresh, '', cookies.getClearRefreshCookieOptions(c.cookie));
        res.cookie(names.csrf, '', cookies.getClearCsrfCookieOptions(c.cookie));
        res.redirect(303, c.frontend + '/');
    } catch {
        // Never log callback arguments, provider tokens or identifying claims.
        if (c) res.redirect(303, c.frontend + '/login?reason=sso_failed');
        else res.status(503).json({ status: 503, message: 'El acceso Hemia no está disponible.' });
    }
});
return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;

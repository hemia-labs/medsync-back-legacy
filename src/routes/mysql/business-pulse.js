'use strict';
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { createPulseController } = require('../../controller/mysql/businessPulse.controller');
function createRouter(service, auth = Token.Auth, operational = requireTenantOperational) {
    const router = require('express').Router(), controller = createPulseController(service);
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const send = res.send;
        res.send = function (body) { if (this.statusCode >= 400 && body && typeof body === 'object' && body.status) body = { status: this.statusCode, data: null, message: body.message || 'No pudimos autorizar esta lectura.', ...((body.code || body.data?.code) ? { code: body.code || body.data.code } : {}) }; return send.call(this, body); };
        next();
    });
    for (const path of ['/snapshot','/incidents','/history','/appointment-result']) router.get(path, auth, operational, controller);
    return router;
}
module.exports = createRouter(require('../../services/pulse/runtime').service);
module.exports.createRouter = createRouter;

'use strict';
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const { createPulseController } = require('../../controller/mysql/businessPulse.controller');
function createRouter(service, auth = Token.Auth, operational = requireTenantOperational) {
    const router = require('express').Router(), controller = createPulseController(service);
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const send = res.send;
        // NC1-AUTH-S1: errors are reduced to status/message/code. The code (Token.Auth, access, service) is kept in
        // data.code (canonical, read by the client handler) and at the root (compatibility with the Pulso contract).
        res.send = function (body) { if (this.statusCode >= 400 && body && typeof body === 'object' && body.status) { const code = body.data?.code || body.code; body = { status: this.statusCode, data: code ? { code } : null, message: body.message || 'No pudimos autorizar esta lectura.', ...(code ? { code } : {}) }; } return send.call(this, body); };
        next();
    });
    for (const path of ['/snapshot','/incidents','/history','/appointment-result']) router.get(path, auth, operational, controller);
    return router;
}
module.exports = createRouter(require('../../services/pulse/runtime').service);
module.exports.createRouter = createRouter;

'use strict';
const { invalidate } = require('../services/pulse/invalidation');
// Explicit writers: searches, previews and audit-only actions never invalidate.
const WRITERS = [
 ['POST', /^\/api\/appointment\/(save|reschedule|config\/(save|timezone))\/?$/], ['DELETE', /^\/api\/appointment\/delete\/?$/],
 ['POST', /^\/api\/tracing\/(save|cancel)\/?$/], ['PUT', /^\/api\/tracing\/update\/?$/], ['DELETE', /^\/api\/tracing\/delete\/?$/],
 ['POST', /^\/api\/document\/(template\/save|signature-request\/(create|email|revoke)|create|sign|refusal|cancel)\/?$/],
 ['POST', /^\/api\/prescription\/(config\/save|save|issue|cancel)\/?$/], ['DELETE', /^\/api\/prescription\/draft\/?$/],
 ['POST', /^\/api\/px\/(create-minimal|save)\/?$/], ['PUT', /^\/api\/px\/(update|administrative|restore)\/?$/], ['DELETE', /^\/api\/px\/(delete|force-delete)\/?$/],
 ['POST', /^\/api\/user\/(create|professional-profile\/[^/]+)\/?$/], ['PUT', /^\/api\/user\/update\/[^/]+\/?$/],
 ['PUT', /^\/api\/rol\/permissions\/[^/]+\/?$/], ['PUT', /^\/api\/business\/current\/?$/],
 ['POST', /^\/api\/clinical-history\/(draft|[^/]+\/(finalize|cancel))\/?$/], ['PUT', /^\/api\/clinical-history\/(patient\/[^/]+\/intake|[^/]+\/draft)\/?$/],
 ['POST', /^\/api\/treatment\/plan\/(create|update|close|treatment\/(save|status)|consent\/(save|prepare|document\/sign))\/?$/], ['DELETE', /^\/api\/treatment\/plan\/treatment\/delete\/?$/],
 ['POST', /^\/api\/config\/signatureconten\/save\/?$/], ['PUT', /^\/api\/config\/signatureconten\/update\/?$/]
];
function pulseInvalidation(req, res, next) {
    if (!WRITERS.some(([method, pattern]) => method === req.method && pattern.test((req.originalUrl || '').split('?')[0].toLowerCase()))) return next();
    const send = res.send; let notified = false;
    res.send = function (body) {
        // Success is sent after the awaited DAO operation/commit, before the caller can refresh.
        if (!notified && this.statusCode >= 200 && this.statusCode < 300 && body && typeof body === 'object' && body.status === 200 && req.tokenDecode?.id_business) { notified = true; invalidate(req.tokenDecode.id_business); }
        return send.call(this, body);
    }; next();
}
module.exports = { pulseInvalidation, WRITERS };

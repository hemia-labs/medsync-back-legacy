'use strict';
const db = require('../../db/Sequelize.connection');
const { PulseRepository } = require('./repository');
const { PulseAccess } = require('./access');
const { PulseHistory } = require('./history');
const { PulseService } = require('./snapshot.service');
const { PulseObservability } = require('./observability');
const { createMetricsLogger } = require('./metricsLogger');
const history = new PulseHistory(db);
const observer = new PulseObservability();
const onMetric = (name, values) => { try { observer.record(name, values); } catch (_) { /* Optional diagnostics must not fail a read or saved operation. */ } };
const service = new PulseService({ repository: new PulseRepository(db, { onMetric }), access: new PulseAccess(db), history, secret: require('../../config/jwt').key, onMetric });
require('./invalidation').subscribe(business => service.invalidate(business));
const metrics = () => observer.snapshot({ entries: service.cache.entries.size, bytes: service.cache.bytes, inflight: service.cache.pending.size });
let stopLogger = null;
function startMetricsLogging(options = {}) {
    if (stopLogger) return stopLogger;
    const stop = createMetricsLogger({ metrics, enabled: process.env.PULSE_METRICS_LOG_ENABLED === 'true', ...options });
    if (!stop) return null;
    let stopped = false;
    const dispose = () => { if (stopped) return; stopped = true; stop(); if (stopLogger === dispose) stopLogger = null; };
    stopLogger = dispose; return dispose;
}
module.exports = { service, history, onMetric, metrics, startMetricsLogging };

'use strict';
function createMetricsLogger({ metrics, enabled = false, log = line => console.info(line), schedule = setInterval, cancel = clearInterval } = {}) {
    if (enabled !== true) return null;
    let active = true;
    const tick = () => {
        if (!active) return;
        try { log('[PULSE_METRICS] ' + JSON.stringify({ version: 'pulse-ops-v1', at: new Date().toISOString(), metrics: metrics() })); } catch (_) { /* Diagnostics never fail business operations or create a retry loop. */ }
    };
    const timer = schedule(tick, 60000); timer.unref?.();
    return () => { if (!active) return; active = false; cancel(timer); };
}
module.exports = { createMetricsLogger };

'use strict';
// Existing in-process job convention; distributed ownership lives in the capture table.
function createPulseJob({ service, history, now = Date.now, onMetric = () => {} }) {
    let running = false;
    const tick = async () => {
        if (running) return { skipped: true }; running = true;
        const result = { claimed: 0, captured: 0, failures: 0 };
        try {
            const candidates = await history.candidates(now(), 25);
            for (const row of candidates) {
                try {
                    const claim = await history.claim(row.id_business, row.timezone, now()); if (!claim) continue; result.claimed++;
                    // A daily capture is a new read, not a cached live snapshot made before 18:00.
                    service.invalidate(row.id_business);
                    const { snapshot } = await service.canonical(row.id_business, true);
                    if (await history.complete(claim, snapshot, now())) result.captured++;
                } catch (_) { result.failures++; } // Lease may be recovered within window. Never backfill.
            }
            await history.purge(now()); onMetric('daily', result); return result;
        } finally { running = false; }
    };
    return { tick, start() { const timer = setInterval(() => tick().catch(() => onMetric('daily_error')), 60000); timer.unref?.(); tick().catch(() => onMetric('daily_error')); return () => clearInterval(timer); } };
}
function startBusinessPulseJob() {
    // Explicit activation after migration/QA; no new infrastructure, no startup grants/DDL.
    if (process.env.PULSE_JOBS_ENABLED !== 'true') return null;
    const runtime = require('../services/pulse/runtime');
    return createPulseJob(runtime).start();
}
module.exports = { createPulseJob, startBusinessPulseJob };

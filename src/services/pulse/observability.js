'use strict';
const EVENTS = ['hit', 'miss', 'coalesced', 'invalidated', 'calculated', 'daily', 'daily_error', 'calculationFailed', 'busy', 'changedDuringRead', 'source'];
const SOURCES = ['followUps', 'signatures', 'appointments', 'preparation', 'preparationSigning', 'activity'];
const LIMITS = [50, 150, 500, 750, 1500, 2000, null];
const emptyCounts = () => Object.fromEntries(EVENTS.map(id => [id, 0]));
const emptySource = () => ({ ok: 0, unavailable: 0, failed: 0, totalMs: 0 });
const bounded = n => Number.isFinite(n) && n >= 0 ? Math.min(n, 60000) : null;
class PulseObservability {
    constructor({ now = Date.now } = {}) {
        this.now = now; this.totals = emptyCounts(); this.buckets = Array.from({ length: 5 }, () => null);
        this.lastCalculationMs = null; this.lastQueryCount = null;
    }
    record(name, values = {}) {
        values = values && typeof values === 'object' ? values : {};
        if (!EVENTS.includes(name)) return;
        if (name === 'source' && (!SOURCES.includes(values.source) || !['ok', 'unavailable', 'failed'].includes(values.outcome))) return;
        const minute = Math.floor(this.now() / 60000), index = ((minute % 5) + 5) % 5;
        if (!this.buckets[index] || this.buckets[index].minute !== minute) this.buckets[index] = { minute, counts: emptyCounts(), sources: Object.fromEntries(SOURCES.map(id => [id, emptySource()])), durations: LIMITS.map(() => 0), slow: 0, dailyFailures: 0 };
        const bucket = this.buckets[index]; this.totals[name]++; bucket.counts[name]++;
        if (name === 'calculated') {
            const elapsed = bounded(values.elapsedMs), queries = bounded(values.queries);
            this.lastCalculationMs = elapsed; this.lastQueryCount = queries;
            if (elapsed !== null) { bucket.durations[LIMITS.findIndex(limit => limit === null || elapsed <= limit)]++; if (elapsed >= 750) bucket.slow++; }
        }
        if (name === 'source') { const source = bucket.sources[values.source]; source[values.outcome]++; source.totalMs += bounded(values.elapsedMs) || 0; }
        if (name === 'daily') bucket.dailyFailures += bounded(values.failures) || 0;
    }
    snapshot(cache = {}) {
        const minute = Math.floor(this.now() / 60000), counts = emptyCounts(), sources = Object.fromEntries(SOURCES.map(id => [id, emptySource()])), histogram = LIMITS.map(() => 0); let slow = 0, dailyFailures = 0;
        for (const bucket of this.buckets) if (bucket && bucket.minute <= minute && bucket.minute > minute - 5) {
            for (const name of EVENTS) counts[name] += bucket.counts[name];
            for (const id of SOURCES) for (const key of Object.keys(sources[id])) sources[id][key] += bucket.sources[id][key];
            bucket.durations.forEach((n, i) => { histogram[i] += n; }); slow += bucket.slow; dailyFailures += bucket.dailyFailures;
        }
        const cacheEntries = bounded(cache.entries) || 0, cacheBytes = Number.isFinite(cache.bytes) && cache.bytes >= 0 ? cache.bytes : 0, inflight = bounded(cache.inflight) || 0;
        const alerts = [];
        if (counts.calculationFailed || counts.busy || counts.changedDuringRead) alerts.push({ code: 'PULSE_CALCULATION_FAILED', level: 'error', action: 'inspect-failures-and-pool' });
        if (Object.values(sources).some(s => s.unavailable || s.failed)) alerts.push({ code: 'PULSE_SOURCE_DEGRADED', level: 'warning', action: 'inspect-source-schema-and-freshness' });
        if (slow) alerts.push({ code: 'PULSE_CALCULATION_SLOW', level: 'warning', action: 'profile-v2-without-changing-rules' });
        if (counts.daily_error || dailyFailures) alerts.push({ code: 'PULSE_HISTORY_JOB_FAILED', level: 'warning', action: 'inspect-job-window-lease-and-retention' });
        if (cacheEntries >= 90 || cacheBytes >= .9 * 16 * 1048576 || inflight >= 90) alerts.push({ code: 'PULSE_CACHE_PRESSURE', level: 'warning', action: 'inspect-capacity-and-ttl' });
        return { ...this.totals, lastCalculationMs: this.lastCalculationMs, lastQueryCount: this.lastQueryCount, cacheEntries, cacheBytes, inflight, window: { minutes: 5, counts, sources, calculationDurationMs: LIMITS.map((upperMs, i) => ({ upperMs, count: histogram[i] })), slowCalculations: slow, dailyFailures }, alerts };
    }
}
module.exports = { PulseObservability };

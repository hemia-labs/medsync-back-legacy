'use strict';
const assert = require('node:assert/strict');
const { PulseObservability } = require('../../src/services/pulse/observability');
let now = 20 * 60000; const observed = new PulseObservability({ now: () => now });
observed.record('source', { source: 'signatures', outcome: 'unavailable', elapsedMs: 9, patientName: 'SECRET_QA_SENTINEL', id_business: 'SECRET_QA_SENTINEL' });
observed.record('calculationFailed', { error: 'SECRET_QA_SENTINEL' }); observed.record('calculated', { elapsedMs: 900, queries: 11 });
const first = observed.snapshot({ entries: 90, bytes: 16 * 1048576, inflight: 90 });
assert.deepEqual(first.alerts.map(a => a.code), ['PULSE_CALCULATION_FAILED', 'PULSE_SOURCE_DEGRADED', 'PULSE_CALCULATION_SLOW', 'PULSE_CACHE_PRESSURE']);
assert.equal(first.window.sources.signatures.unavailable, 1); assert.equal(first.window.calculationDurationMs[4].count, 1); assert.equal(first.lastQueryCount, 11);
assert.equal(JSON.stringify(first).includes('SECRET_QA_SENTINEL'), false);
for (let i = 0; i < 10000; i++) { observed.record('SECRET_QA_SENTINEL' + i); observed.record('source', { source: 'SECRET_QA_SENTINEL' + i, outcome: 'ok' }); }
observed.record('source', null); observed.record('calculated', { elapsedMs: Infinity, queries: -1 });
assert.equal(observed.snapshot().window.counts.source, 1); assert.equal(observed.buckets.length, 5);
now += 5 * 60000;
assert.equal(observed.snapshot().alerts.length, 0); assert.equal(observed.snapshot().window.counts.source, 0); assert.equal(observed.snapshot().source, 1);
for (let i = 0; i < 100; i++) { now += 60000; observed.record('hit'); }
assert.equal(observed.snapshot().window.counts.hit, 5); assert.equal(observed.snapshot().hit, 100); assert.equal(observed.buckets.length, 5);
const copy = observed.snapshot(); copy.window.sources.signatures.ok = 999; assert.equal(observed.snapshot().window.sources.signatures.ok, 0);
assert.equal(observed.snapshot({ bytes: NaN }).cacheBytes, 0);
observed.record('daily_error'); observed.record('daily', { failures: 2 });
assert.equal(observed.snapshot().window.dailyFailures, 2); assert.ok(observed.snapshot().alerts.some(a => a.code === 'PULSE_HISTORY_JOB_FAILED'));
const { createMetricsLogger } = require('../../src/services/pulse/metricsLogger');
let scheduled = 0, cancelled = 0, emit; const lines = [];
const schedule = (fn, ms) => { scheduled++; assert.equal(ms, 60000); emit = fn; return { unref() {} }; };
assert.equal(createMetricsLogger({ metrics: () => observed.snapshot(), enabled: false, schedule }), null); assert.equal(scheduled, 0);
const stop = createMetricsLogger({ metrics: () => observed.snapshot(), enabled: true, schedule, cancel: () => cancelled++, log: line => lines.push(line) });
emit(); assert.ok(lines[0].startsWith('[PULSE_METRICS] ')); assert.equal(lines[0].includes('SECRET_QA_SENTINEL'), false); stop(); stop(); emit(); assert.equal(cancelled, 1); assert.equal(lines.length, 1);
console.log('PASS Pulse observability: allowlist/privacy, bounded windows/histograms, alerts/recovery, finite values and detached output. Controlled clock; no SQL/browser.');

'use strict';
// Pulse UX (2026-10-26): per-severity ages, last-known dedupe, invalid-records page, controller guard and rescues.
const assert = require('node:assert/strict');
const { build } = require('../../src/domain/pulse/rules');
const { page, aggregate } = require('../../src/domain/pulse/queries');
const { createPulseController } = require('../../src/controller/mysql/businessPulse.controller');
const results = [], check = async (name, fn) => { await fn(); results.push({ name, result: 'PASS' }); };
const meta = { asOf: Date.parse('2026-10-20T18:00:00Z'), id: 'q:1', epoch: 'q', sequence: 1, generation: 0, timeZone: 'America/Mexico_City', timeZoneSource: 'configured' };
const row = (o = {}) => ({ numerator: 0, denominator: 0, priorityCount: 0, oldestAgeDays: null, oldestAttentionAgeDays: null, invalidRecords: 0, nextTransitionAt: null, ...o });
const input = () => ({ followUps: row(), signatures: row(), appointments: row() });
const call = async (path, query) => { const calls = []; const service = { incidents: async (...a) => { calls.push(a); return { items: [] }; } }; let status = 200; const res = { set() {}, status(s) { status = s; return this; }, send(b) { return b; } }; await createPulseController(service)({ path, query, body: {}, params: {}, tokenDecode: { id_business: 'a' } }, res); return { status, calls }; };
(async () => {
  await check('attention incident reports its own oldest age, not the priority age', () => {
    const x = input(); x.appointments = row({ numerator: 5, denominator: 9, priorityCount: 2, oldestAgeDays: 40, oldestAttentionAgeDays: 3 });
    const inc = build(x, meta).incidents;
    assert.equal(inc.find(i => i.id === 'PUL-OP03:priority').oldestAgeDays, 40);
    assert.equal(inc.find(i => i.id === 'PUL-OP03:attention').oldestAgeDays, 3);
  });
  await check('legacy aggregate without attention age keeps previous behaviour', () => {
    const x = input(); x.appointments = row({ numerator: 2, denominator: 2, oldestAgeDays: 6 }); delete x.appointments.oldestAttentionAgeDays;
    assert.equal(build(x, meta).incidents[0].oldestAgeDays, 6);
  });
  await check('last known unresolved is dropped when a fresh partial read already shows it', () => {
    const x = input(); x.signatures = row({ numerator: 3, denominator: 5, priorityCount: 0, oldestAgeDays: 2, oldestAttentionAgeDays: 2 });
    const old = build(x, meta);
    x.signatures = { ...x.signatures, invalidRecords: 1 };
    assert.equal(build(x, meta, old).lastKnownUnresolved.length, 0);
    x.signatures = { ...x.signatures, numerator: 1 };
    assert.equal(build(x, meta, old).lastKnownUnresolved.length, 1, 'lower live count must keep the earlier record visible');
    x.signatures = null;
    assert.equal(build(x, meta, old).lastKnownUnresolved[0].resolution, 'unknown');
  });
  await check('invalid page selects reasons, ignores cursor and keeps patient scope', () => {
    for (const id of ['PUL-OP01', 'PUL-OP02', 'PUL-OP03']) {
      const sql = page(id, true, 'invalid');
      assert.match(sql, /invalid=1 AND \(patientActive=1 OR patientExists IS NULL\)/);
      assert.doesNotMatch(sql, /:lastId/);
      assert.doesNotMatch(sql, /NULL AS invalidReason/);
      assert.match(sql, /:business/);
    }
    assert.match(page('PUL-OP03', false), /AS startTime/);
    assert.match(page('PUL-OP03', false), /displayDoctor\.id_business=:business/);
    assert.match(page('PUL-OP01', true), /:lastId/);
    assert.match(page('PUL-OP01', false), /NULL AS invalidReason/);
  });
  await check('controller allowlists kind and rejects invalid+cursor', async () => {
    assert.equal((await call('/incidents', { indicatorId: 'PUL-OP01', kind: 'other' })).status, 400);
    assert.equal((await call('/incidents', { indicatorId: 'PUL-OP01', kind: 'invalid', cursor: 'x' })).status, 400);
    const ok = await call('/incidents', { indicatorId: 'PUL-OP02', kind: 'invalid', limit: '50' });
    assert.equal(ok.status, 200); assert.equal(ok.calls[0][4], 'invalid');
    const def = await call('/incidents', { indicatorId: 'PUL-OP02' });
    assert.equal(def.calls[0][4], 'pending');
  });
  await check('rescues: attention pendings crossing the threshold within 24h, never priority or invalid', () => {
    assert.match(aggregate('PUL-OP01'), /SUM\(\(pending=1 AND priority=0 AND ageDays>=13\)\),0\) AS rescueCount/);
    for (const id of ['PUL-OP02', 'PUL-OP03']) assert.match(aggregate(id), /pending=1 AND priority=0 AND DATE_ADD\(dueAt,INTERVAL 7 DAY\)<=DATE_ADD\(:asOf,INTERVAL 24 HOUR\)\)(\*weight)?\),0\) AS rescueCount/);
    assert.match(aggregate('PUL-OP03'), /\)\*weight\),0\) AS rescueCount/);
    assert.match(page('PUL-OP02', false), /CASE WHEN pending=1 AND priority=0 AND .* THEN 1 ELSE 0 END AS rescue/);
    assert.match(page('PUL-OP02', false, 'invalid'), /,0 AS rescue/);
    const x = input(); x.signatures = row({ numerator: 4, denominator: 6, priorityCount: 1, oldestAgeDays: 9, oldestAttentionAgeDays: 6, rescueCount: 2 });
    const r = build(x, meta); assert.equal(r.dimensions[1].rescueCount, 2); assert.equal(r.dimensions[0].rescueCount, null, 'aggregate without the field stays unknown');
    x.signatures = null; assert.equal(build(x, meta).dimensions[1].rescueCount, null);
  });
  console.log(JSON.stringify({ result: 'PASS', tests: results.length, results }, null, 2));
})().catch(e => { console.error(e.stack); process.exitCode = 1; });

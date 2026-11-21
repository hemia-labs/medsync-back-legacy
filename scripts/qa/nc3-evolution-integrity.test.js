'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/evolutionIntegrity.service');
const cfg = service.config({ EVOLUTION_INTEGRITY_KEYS: 'k1:' + 'ab'.repeat(32), EVOLUTION_INTEGRITY_KEY_ID: 'k1' });
const row = (version, patch = {}) => ({ id_business: 'b', id_person: 'p', note_id: 'n', version, author_id: 'a', signer_profile: 'sp',
    signer_name: 'Dra', signer_license: '1', signed_at_text: '2026-01-01 10:00:0' + version + '.123456', correction_reason: version > 1 ? 'motivo' : null,
    payload: { plan: 'x', done: [{ id: '1' }] }, ...patch });
function sealAll(rows) {
    const entries = []; let head = null, previous = null;
    for (const r of rows) {
        const out = service.seal({ cfg, row: r, previousDigest: previous, head, now: new Date('2026-01-02T00:00:00.000Z') });
        entries.push(out.entry); head = out.head; previous = out.entry.digest;
    }
    return { entries, head };
}
test('la representación es estable ante el orden de claves y cubre cada campo protegido', () => {
    assert.equal(service.stable({ b: 1, a: { d: 1, c: [2, 1] } }), service.stable({ a: { c: [2, 1], d: 1 }, b: 1 }));
    const base = service.digest(row(1));
    assert.equal(service.digest(row(1, { payload: { done: [{ id: '1' }], plan: 'x' } })), base);
    for (const patch of [{ id_business: 'z' }, { id_person: 'z' }, { note_id: 'z' }, { author_id: 'z' }, { signer_profile: 'z' }, { signer_name: 'z' },
        { signer_license: 'z' }, { signed_at_text: '2026-01-01 10:00:01.123457' }, { correction_reason: 'z' }, { payload: { plan: 'y', done: [{ id: '1' }] } }])
        assert.notEqual(service.digest(row(1, patch)), base, JSON.stringify(patch));
    assert.notEqual(service.digest(row(2, { signed_at_text: row(1).signed_at_text, correction_reason: null })), base);
});
test('verifica íntegra, detecta contenido, versión ausente y cola truncada', () => {
    const rows = [row(1), row(2)], ref = sealAll(rows);
    assert.equal(service.verify({ rows, ...ref, cfg }).state, 'verified');
    assert.equal(service.verify({ rows: [row(1), row(2, { signer_name: 'otra' })], ...ref, cfg }).notes.get('n').versions.get(2).code, 'CONTENT_MISMATCH');
    assert.equal(service.verify({ rows: [row(2)], ...ref, cfg }).notes.get('n').versions.get(1).code, 'VERSION_MISSING');
    assert.equal(service.verify({ rows: [row(1)], ...ref, cfg }).notes.get('n').versions.get(2).code, 'VERSION_MISSING');
    assert.equal(service.verify({ rows: [], ...ref, cfg }).state, 'discrepancy');
    const truncated = { entries: ref.entries.slice(0, 1), head: ref.head };
    assert.ok(service.verify({ rows: [row(1)], ...truncated, cfg }).faults.some(f => f.code === 'LEDGER_TRUNCATED'));
});
test('sin la clave la referencia no valida y sin clave configurada se declara no disponible', () => {
    const rows = [row(1)], ref = sealAll(rows);
    const forged = { ...ref, entries: [{ ...ref.entries[0], digest: 'f'.repeat(64) }] };
    assert.equal(service.verify({ rows, ...forged, cfg }).notes.get('n').versions.get(1).code, 'LEDGER_ENTRY_INVALID');
    const none = service.config({});
    assert.equal(none.current, null);
    assert.equal(service.verify({ rows, ...ref, cfg: none }).state, 'unavailable');
});
test('una nota heredada es histórica y una fila posterior a la adopción sin asiento es discrepancia', () => {
    const adopting = { ...cfg, adoptionAt: '2026-06-01 00:00:00.000000' };
    assert.equal(service.verify({ rows: [row(1)], entries: [], head: null, cfg: adopting }).notes.get('n').state, 'historical');
    const late = row(1, { signed_at_text: '2026-07-01 00:00:00.000000' });
    assert.equal(service.verify({ rows: [late], entries: [], head: null, cfg: adopting }).notes.get('n').versions.get(1).code, 'UNREFERENCED_VERSION');
});

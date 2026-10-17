const assert = require('node:assert/strict');
const { validateList } = require('../../src/validators/prescription.validator');
const validatePayload = require('../../src/middleware/validatePayload.middleware');
const cases = [
    [{}, true], [{ date_from: '2026-10-16' }, true], [{ date_to: '2026-10-16' }, true],
    [{ date_from: '2026-10-16', date_to: '2026-10-16' }, true],
    [{ date_from: '2026-10-01', date_to: '2026-10-30' }, true],
    [{ date_from: '2026-10-30', date_to: '2026-10-01' }, false],
    [{ date_from: '2026-02-29' }, false], [{ date_to: '2026-02-31' }, false],
    [{ date_from: '2024-02-29' }, true], [{ date_from: ['2026-10-01'] }, false],
    [{ date_to: '01/10/2026' }, false], [{ date_from: { value: '2026-10-01' } }, false]
];
for(const [query, valid] of cases) {
    assert.equal(validateList({ query }).isValid, valid, JSON.stringify(query));
    let next = false, status = null, body = null;
    const res = { status(value) { status = value; return this; }, send(value) { body = value; } };
    validatePayload(validateList)({ query }, res, () => { next = true; });
    assert.equal(next, valid);
    if(!valid) { assert.equal(status, 400); assert.ok(body); }
}
assert.match(validateList({ query: { date_from: '2026-10-30', date_to: '2026-10-01' } }).message, /Hasta.*Desde/);
console.log('PASS prescription list filters: calendar dates, equality, open ranges, inversion, malformed types and HTTP 400 before the handler. No database or network.');

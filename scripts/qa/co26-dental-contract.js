'use strict';
// Pure domain QA: no configuration, database, services or clinical records.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const contract = require('../../src/domain/odontogram/dentalContract');

test('FDI: 32 permanent and 20 primary, independent in mixed dentition', () => {
    assert.equal(contract.sequence('permanent').length, 32);
    assert.equal(contract.sequence('primary').length, 20);
    const mixed = contract.sequence('mixed');
    assert.equal(new Set(mixed).size, 52);
    assert.ok(mixed.includes(11) && mixed.includes(51));
    for (const tooth of mixed) assert.equal(contract.toothNumber(String(tooth)), tooth);
    for (const invalid of [0, 19, 49, 56, 86, 99, '011', '11 ', null, {}, true]) {
        assert.throws(() => contract.toothNumber(invalid));
    }
    assert.throws(() => contract.sequence('unknown'));
    mixed.pop();
    assert.equal(contract.sequence('mixed').length, 52);
});

test('anatomical ranges cross midline, never arch or dentition', () => {
    assert.deepEqual(contract.anatomicalRange(13, 23, 'permanent'), [13, 12, 11, 21, 22, 23]);
    assert.deepEqual(contract.anatomicalRange(23, 13, 'mixed'), [23, 22, 21, 11, 12, 13]);
    assert.deepEqual(contract.anatomicalRange(52, 62, 'primary'), [52, 51, 61, 62]);
    assert.deepEqual(contract.anatomicalRange(33, 43, 'mixed'), [33, 32, 31, 41, 42, 43]);
    for (const [a, b, mode] of [[18, 38, 'mixed'], [11, 51, 'mixed'], [51, 61, 'permanent'], [15, 99, 'mixed']]) {
        assert.throws(() => contract.anatomicalRange(a, b, mode));
    }
});

test('canonical MODVL, aliases and missing location have distinct semantics', () => {
    assert.equal(contract.normalizeSurfaces('vlmodm'), 'MODVL');
    assert.equal(contract.normalizeSurfaces('pim'), 'MOL');
    assert.deepEqual(contract.normalizeLocation(null, true), { surfaces: null, surface_pending: true });
    assert.deepEqual(contract.normalizeLocation(null), { surfaces: null, surface_pending: false });
    assert.deepEqual(contract.normalizeLocation('dm'), { surfaces: 'MD', surface_pending: false });
    for (const value of ['', '?', 'x', undefined, ['M'], 'M O']) {
        assert.throws(() => contract.normalizeSurfaces(value));
    }
    assert.throws(() => contract.normalizeLocation('M', true));
    assert.throws(() => contract.normalizeLocation(undefined));
    assert.throws(() => contract.normalizeLocation(null, 'true'));
    assert.equal(contract.surfaceLabel('O', 11), 'I');
    assert.equal(contract.surfaceLabel('L', 55), 'P');
    assert.equal(contract.surfaceLabel('L', 75), 'L');
    assert.equal(contract.surfaceLabel('O', 16), 'O');
});

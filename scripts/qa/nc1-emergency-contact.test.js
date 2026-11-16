'use strict';
// NC1-EC1: emergency contact contract and store, synthetic data only, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const EC = require('../../src/domain/patientContact/emergencyContact');
const { validatePxAdministrative } = require('../../src/validators/px.validator');

const fakeDb = (rows = []) => {
    const calls = [];
    return {
        calls,
        rows,
        async query(sql, options = {}) {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), replacements: options.replacements, transaction: options.transaction });
            if (options.type === 'SELECT') return rows;
            return [[], 0];
        }
    };
};
const tx = { id: 'synthetic-transaction' };

test('normalize: absent, null and object forms', () => {
    assert.equal(EC.normalize(undefined), undefined);
    assert.equal(EC.normalize(null), null);
    assert.deepEqual(EC.normalize({ name: '  Ana   Prueba ', phone: '(55) 1234-5678', relationship: ' Hermana ' }), { name: 'Ana Prueba', phone: '5512345678', relationship: 'Hermana' });
    assert.deepEqual(EC.normalize({ name: 'Solo nombre' }), { name: 'Solo nombre', phone: null, relationship: null });
    assert.deepEqual(EC.normalize({ name: 'Con vacíos', phone: '', relationship: '   ' }), { name: 'Con vacíos', phone: null, relationship: null });
});

test('normalize: rejects invalid shapes with a field code', () => {
    const bad = [
        [[], 'value'], ['texto', 'value'], [{}, 'name'], [{ name: '   ' }, 'name'], [{ name: 5 }, 'name'],
        [{ name: 'x'.repeat(256) }, 'name'], [{ name: 'Ana', phone: '123' }, 'phone'], [{ name: 'Ana', phone: 5512345678 }, 'phone'],
        [{ name: 'Ana', relationship: 'x'.repeat(151) }, 'relationship'], [{ name: 'Ana', email: 'a@b.c' }, 'email']
    ];
    for (const [value, field] of bad) {
        assert.throws(() => EC.normalize(value), error => error.status === 400 && error.code === 'EMERGENCY_CONTACT_INVALID' && error.field === 'emergencyContact.' + field, JSON.stringify(value));
    }
});

test('validator: administrative payload accepts absent/null/valid contact and rejects invalid ones', () => {
    const body = { person: { id_person: 'synthetic-person', name: 'Paciente', surname: 'Ficticio', birthday: '2000-01-01', age: new Date().getFullYear() - 2000 - (new Date() < new Date(new Date().getFullYear(), 0, 1) ? 1 : 0), telephone: '5555555555' }, address: {} };
    assert.equal(validatePxAdministrative({ body }).isValid, true);
    assert.equal(validatePxAdministrative({ body: { ...body, emergencyContact: null } }).isValid, true);
    assert.equal(validatePxAdministrative({ body: { ...body, emergencyContact: { name: 'Contacto ficticio', phone: '5511112222', relationship: 'Madre' } } }).isValid, true);
    const invalid = validatePxAdministrative({ body: { ...body, emergencyContact: { name: 'Contacto', phone: '12' } } });
    assert.equal(invalid.isValid, false);
    assert.deepEqual(invalid.data, { code: 'EMERGENCY_CONTACT_INVALID', field: 'emergencyContact.phone' });
});

test('store.read: returns the newest active primary contact, scoped by tenant', async () => {
    const db = fakeDb([{ contact_name: 'Ana', contact_phone: null, relationship: 'Hermana' }]);
    const value = await EC.createStore(db).read('p1', 'tenant');
    assert.deepEqual(value, { name: 'Ana', phone: null, relationship: 'Hermana' });
    assert.match(db.calls[0].sql, /id_person = :patient AND id_business = :business AND active = 1 AND is_primary = 1/);
    assert.deepEqual(db.calls[0].replacements, { patient: 'p1', business: 'tenant' });
    assert.equal(await EC.createStore(fakeDb([])).read('p1', 'tenant'), null);
});

test('store.read: tolerates an environment without the table, other errors propagate', async () => {
    const missing = { async query() { throw Object.assign(new Error('missing'), { original: { code: 'ER_NO_SUCH_TABLE' } }); } };
    assert.equal(await EC.createStore(missing).read('p1', 'tenant'), null);
    const broken = { async query() { throw Object.assign(new Error('boom'), { original: { code: 'ER_ACCESS_DENIED_ERROR' } }); } };
    await assert.rejects(EC.createStore(broken).read('p1', 'tenant'), /boom/);
});

test('store.write: absent value never touches the table', async () => {
    const db = fakeDb();
    assert.deepEqual(await EC.createStore(db).write('p1', 'tenant', 'actor', undefined, tx), { changed: false });
    assert.equal(db.calls.length, 0);
});

test('store.write: requires actor and transaction', async () => {
    await assert.rejects(EC.createStore(fakeDb()).write('p1', 'tenant', null, { name: 'Ana' }, tx), /actor and transaction/);
    await assert.rejects(EC.createStore(fakeDb()).write('p1', 'tenant', 'actor', { name: 'Ana' }, null), /actor and transaction/);
});

test('store.write: inserts the first contact inside the caller transaction', async () => {
    const db = fakeDb([]);
    assert.deepEqual(await EC.createStore(db).write('p1', 'tenant', 'actor', { name: 'Ana', phone: '55 1111 2222' }, tx), { changed: true });
    assert.match(db.calls[0].sql, /FOR UPDATE$/);
    assert.match(db.calls[1].sql, /^INSERT INTO patient_emergency_contacts/);
    assert.equal(db.calls[1].replacements.phone, '5511112222');
    assert.equal(db.calls[1].replacements.business, 'tenant');
    assert.ok(db.calls.every(call => call.transaction === tx));
});

test('store.write: updates the current contact and skips identical values', async () => {
    const row = { id_patient_emergency_contact: 'c1', contact_name: 'Ana', contact_phone: '5511112222', relationship: null };
    const same = fakeDb([row]);
    assert.deepEqual(await EC.createStore(same).write('p1', 'tenant', 'actor', { name: 'Ana', phone: '5511112222' }, tx), { changed: false });
    assert.equal(same.calls.length, 1);
    const changed = fakeDb([row]);
    assert.deepEqual(await EC.createStore(changed).write('p1', 'tenant', 'actor', { name: 'Ana', phone: '5511112222', relationship: 'Hermana' }, tx), { changed: true });
    assert.match(changed.calls[1].sql, /^UPDATE patient_emergency_contacts SET contact_name/);
    assert.equal(changed.calls[1].replacements.id, 'c1');
    assert.match(changed.calls[1].sql, /id_business = :business/);
});

test('store.write: null retires the active contact without deleting it', async () => {
    const db = fakeDb([{ id_patient_emergency_contact: 'c1', contact_name: 'Ana' }]);
    assert.deepEqual(await EC.createStore(db).write('p1', 'tenant', 'actor', null, tx), { changed: true });
    assert.match(db.calls[1].sql, /^UPDATE patient_emergency_contacts SET active = 0/);
    assert.ok(!db.calls.some(call => /DELETE/i.test(call.sql)));
    const none = fakeDb([]);
    assert.deepEqual(await EC.createStore(none).write('p1', 'tenant', 'actor', null, tx), { changed: false });
    assert.equal(none.calls.length, 1);
});

test('store.write: duplicate legacy primaries collapse to the newest', async () => {
    const db = fakeDb([
        { id_patient_emergency_contact: 'new', contact_name: 'Ana', contact_phone: null, relationship: null },
        { id_patient_emergency_contact: 'old', contact_name: 'Vieja', contact_phone: null, relationship: null }
    ]);
    assert.deepEqual(await EC.createStore(db).write('p1', 'tenant', 'actor', { name: 'Ana' }, tx), { changed: true });
    assert.match(db.calls[1].sql, /SET is_primary = 0/);
    assert.equal(db.calls[1].replacements.id, 'old');
    assert.equal(db.calls.length, 2);
});

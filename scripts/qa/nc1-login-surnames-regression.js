'use strict';
// NC1 identidad simple — users and registration: names as Nombre(s) + Primer apellido + Segundo apellido.
// Pure checks of userNames and the registration validator; no database or network.
const assert = require('node:assert/strict');
const { userNames } = require('../../src/util/userNames');
const { validateRegistration } = require('../../src/services/registration/registration.validator');
const results = [];
const test = (name, fn) => { fn(); results.push(name); console.log('PASS ' + name); };

test('structured surnames: last_name derived, empty second surname is pending, compound kept whole', () => {
  assert.deepEqual(userNames({ first_name: ' María José ', first_surname: ' De la Cruz ', second_surname: '' }),
    { first_name: 'María José', last_name: 'De la Cruz', name: 'María José De la Cruz', first_surname: 'De la Cruz', second_surname: null });
  assert.deepEqual(userNames({ first_name: 'Ana', first_surname: 'Pérez', second_surname: 'de la Luz' }).last_name, 'Pérez de la Luz');
  assert.equal(userNames({ first_name: 'Ana', first_surname: '   ', second_surname: 'López' }).first_surname, null, 'blank counts as empty');
});

test('minimums: given names and at least one surname; invalid values rejected, not dropped', () => {
  assert.equal(userNames({ first_name: 'Ana', first_surname: '', second_surname: '' }), null);
  assert.equal(userNames({ first_name: '', first_surname: 'Pérez', second_surname: null }), null);
  assert.equal(userNames({ first_name: 'Ana', first_surname: 7, second_surname: null }), null);
  assert.equal(userNames({ first_name: 'Ana', first_surname: 'x'.repeat(201), second_surname: null }), null);
  assert.equal(userNames({ first_name: 'A'.repeat(150), first_surname: 'B'.repeat(60), second_surname: null }), null, '200 characters in total');
  assert.equal(userNames({ first_name: 'Ana', first_surname: 'Pérez', last_name: 'Otra' }), null, 'a different last_name contradicts the surnames');
  assert.equal(userNames({ first_name: 'Ana', first_surname: 'Pérez', second_surname: 'López', last_name: 'Pérez López' }).second_surname, 'López', 'same join accepted (deploy compatibility)');
});

test('editing: unchanged keys keep stored values; explicit clearing does not bring the old value back', () => {
  const current = { name: 'Ana Pérez López', first_name: 'Ana', last_name: 'Pérez López', first_surname: 'Pérez', second_surname: 'López' };
  assert.deepEqual(userNames({ second_surname: null }, current), { first_name: 'Ana', last_name: 'Pérez', name: 'Ana Pérez', first_surname: 'Pérez', second_surname: null });
  assert.equal(userNames({ first_name: 'Ana María' }, current).second_surname, 'López', 'name-only change keeps surnames');
  assert.equal(userNames({ email: 'x' }, current).first_surname, 'Pérez', 'untouched names keep surnames');
});

test('older clients: last_name still accepted; a changed last_name drops the structured surnames (never split)', () => {
  const current = { name: 'Ana Pérez López', first_name: 'Ana', last_name: 'Pérez López', first_surname: 'Pérez', second_surname: 'López' };
  const changed = userNames({ first_name: 'Ana', last_name: 'García Ruiz' }, current);
  assert.equal(changed.last_name, 'García Ruiz'); assert.equal(changed.first_surname, null); assert.equal(changed.second_surname, null);
  assert.equal(userNames({ first_name: 'Ana', last_name: 'Pérez López' }, current).second_surname, 'López', 'same last_name keeps them');
  const legacy = { name: 'Nombre Antiguo Completo', first_name: 'Nombre Antiguo Completo', last_name: '' };
  assert.deepEqual(userNames({}, legacy), { name: legacy.name, first_name: legacy.first_name, last_name: '', first_surname: null, second_surname: null });
  assert.deepEqual(userNames({ first_name: legacy.first_name, last_name: '', phone: '5500000099' }, legacy),
    { ...legacy, first_surname: null, second_surname: null }, 'editing contact preserves an unchanged legacy name with no surname');
  assert.equal(userNames({ first_name: 'Changed', last_name: '' }, legacy), null, 'changed names still require a surname');
});

test('registration: structured account accepted; extra or partial name keys rejected; old shapes kept', () => {
  const base = { business: { name: 'Consultorio QA' }, legalAcceptances: [{ documentKey: 'terms', versionId: 'v1', acknowledged: true }] };
  const accepted = validateRegistration({ ...base, account: { first_name: 'Ana', first_surname: 'Pérez', second_surname: '', email: 'qa.registro@example.invalid', password: 'Clave-segura-QA-2026' } });
  assert.equal(accepted.account.first_name, 'Ana'); assert.equal(accepted.account.first_surname, 'Pérez'); assert.equal(accepted.account.second_surname, null);
  assert.equal(accepted.account.last_name, 'Pérez'); assert.equal(accepted.account.name, 'Ana Pérez');
  const old = validateRegistration({ ...base, account: { first_name: 'Ana', last_name: 'Pérez López', email: 'qa.registro@example.invalid', password: 'Clave-segura-QA-2026' } });
  assert.equal(old.account.last_name, 'Pérez López'); assert.equal(old.account.first_surname, null);
  const rejects = account => assert.throws(() => validateRegistration({ ...base, account: { email: 'qa.registro@example.invalid', password: 'Clave-segura-QA-2026', ...account } }));
  rejects({ first_name: 'Ana', first_surname: 'Pérez' });                                 // both surname keys required
  rejects({ first_name: 'Ana', first_surname: 'Pérez', second_surname: '', last_name: 'X' }); // contradictory last_name
  assert.equal(validateRegistration({ ...base, account: { first_name: 'Ana', first_surname: 'Pérez', second_surname: '', last_name: 'Pérez', email: 'qa.registro@example.invalid', password: 'Clave-segura-QA-2026' } }).account.first_surname, 'Pérez', 'matching last_name accepted');
  rejects({ first_name: 'Ana', first_surname: '', second_surname: '' });                  // at least one surname
});

console.log(`PASS: ${results.length} NC1 login surname groups. No database or network.`);

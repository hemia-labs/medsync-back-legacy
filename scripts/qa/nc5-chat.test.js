'use strict';
// NC5 · Chat interno: reglas puras (orden de destinatarios, validación, datos visibles del aviso).
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../src/domain/chat/chatRules');

const team = [
    { id: 'u-sofia', name: 'Sofía Herrera' },
    { id: 'u-agenda', name: 'Sintetic Agenda' },
    { id: 'u-ana', name: 'Ana Ruiz' },
    { id: 'u-bruno', name: 'Bruno Díaz' }
];
const ids = list => list.map(person => person.id);

test('sin historial: todos por nombre y sin frecuentes', () => {
    const ordered = rules.orderDirectory(team, []);
    assert.deepEqual(ids(ordered), ['u-ana', 'u-bruno', 'u-agenda', 'u-sofia']);
    assert.ok(ordered.every(person => !person.frequent));
});

test('un solo contacto con actividad: se destaca y los demás aparecen una vez', () => {
    const ordered = rules.orderDirectory(team, [{ id: 'u-sofia', count: 3, last: '2026-11-20T10:00:00Z' }]);
    assert.deepEqual(ids(ordered), ['u-sofia', 'u-ana', 'u-bruno', 'u-agenda']);
    assert.deepEqual(ordered.map(person => person.frequent), [true, false, false, false]);
    assert.equal(new Set(ids(ordered)).size, team.length);
});

test('tres con actividad: solo dos frecuentes, empate por envío más reciente y luego por nombre', () => {
    const ordered = rules.orderDirectory(team, [
        { id: 'u-ana', count: 2, last: '2026-11-19T10:00:00Z' },
        { id: 'u-bruno', count: 2, last: '2026-11-20T10:00:00Z' },
        { id: 'u-agenda', count: 1, last: '2026-11-20T11:00:00Z' }
    ]);
    assert.deepEqual(ids(ordered), ['u-bruno', 'u-ana', 'u-agenda', 'u-sofia']);
    assert.deepEqual(ordered.map(person => person.frequent), [true, true, false, false]);
    const tie = rules.orderDirectory(team, [
        { id: 'u-sofia', count: 1, last: '2026-11-20T10:00:00Z' },
        { id: 'u-ana', count: 1, last: '2026-11-20T10:00:00Z' }
    ]);
    assert.deepEqual(ids(tie).slice(0, 2), ['u-ana', 'u-sofia']);
});

test('actividad de personas fuera del directorio no ocupa lugar ni se duplica', () => {
    const ordered = rules.orderDirectory([...team, team[0]], [{ id: 'u-ex', count: 9 }, { id: 'u-ana', count: 1 }]);
    assert.deepEqual(ids(ordered), ['u-ana', 'u-bruno', 'u-agenda', 'u-sofia']);
    assert.deepEqual(ordered.map(person => person.frequent), [true, false, false, false]);
});

test('validación de mensaje, comentario, motivo e identificador de envío', () => {
    assert.equal(rules.body('  Hola  '), 'Hola');
    assert.equal(rules.body('   '), null);
    assert.equal(rules.body('x'.repeat(2001)), null);
    assert.equal(rules.body('\uD800'), null);
    assert.equal(rules.comment(''), '');
    assert.equal(rules.comment('y'.repeat(501)), null);
    assert.equal(rules.reason('control'), 'control');
    assert.equal(rules.reason('toString'), null);
    assert.equal(rules.requestId('abc'), null);
    assert.equal(rules.requestId('9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b'), '9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b');
    assert.equal(rules.requestId('../../etc'), null);
});

test('par de conversación estable sin importar quién escribe', () => {
    assert.deepEqual(rules.pair('b', 'a'), rules.pair('a', 'b'));
});

const notice = {
    kind: 'team_notice', context_ref: 'tr-1', reason_code: 'control', snap_patient_name: 'María García López',
    snap_patient_code: 'P0001', snap_professional_name: 'Valeria Mendoza', snap_attention_date: '2026-11-20'
};

test('aviso: lector con permiso de datos ve paciente; sin Agenda no coordina', () => {
    const view = rules.noticeView(notice, { isSender: false, permissions: ['px.tab.monitoring'] });
    assert.equal(view.patient.name, 'María García López');
    assert.equal(view.canCoordinate, false);
    assert.equal(view.reason.label, 'Control');
    assert.equal(view.reference, 'tr-1');
});

test('aviso: recepción solo con Agenda ve paciente y puede coordinar', () => {
    const view = rules.noticeView(notice, { isSender: false, permissions: ['px.dates'] });
    assert.equal(view.patient.restricted, false);
    assert.equal(view.canCoordinate, true);
});

test('aviso: colega sin permisos de pacientes ve iniciales, sin código ni referencia', () => {
    const view = rules.noticeView(notice, { isSender: false, permissions: [] });
    assert.deepEqual(view.patient, { name: 'M. G. L.', code: null, restricted: true });
    assert.equal(view.reference, null);
    assert.equal(view.canCoordinate, false);
    assert.equal(view.professional, 'Valeria Mendoza');
});

test('aviso: nunca expone nota, tratamientos ni enlaces', () => {
    const view = rules.noticeView({ ...notice, note: 'texto clínico', treatment_now: 'Resina' }, { isSender: true, permissions: ['px.all'] });
    const serialized = JSON.stringify(view);
    assert.ok(!serialized.includes('texto clínico'));
    assert.ok(!serialized.includes('Resina'));
    assert.ok(!/https?:|\/patient|expediente/i.test(serialized));
});

test('vista previa de bandeja', () => {
    assert.equal(rules.preview({ kind: 'team_notice', reason_code: 'revision' }), 'Aviso de seguimiento · Revisión');
    assert.equal([...rules.preview({ kind: 'text', body: 'a'.repeat(200) })].length, 80);
});

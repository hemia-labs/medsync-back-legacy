'use strict';
// NC5 · Chat interno contra MySQL aislado con el DDL exportado del workspace. Lo invoca nc5-chat.docker.sh.
// Se niega a correr sin NC5_QA_ISOLATED=1: nunca debe apuntar a una base real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

if (process.env.NC5_QA_ISOLATED !== '1' || !process.env.NC5_QA_PORT) {
    console.error('Solo en MySQL aislado: defina NC5_QA_ISOLATED=1 y NC5_QA_PORT (use nc5-chat.docker.sh).');
    process.exit(2);
}
const DATABASE = 'medsync_nc5_chat_test';
Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: process.env.NC5_QA_PORT, DB_USER: 'root', DB_PASSWORD: 'isolated-test-only', DB_NAME: DATABASE });

const schemaDir = [process.env.NC5_SCHEMA_DIR, path.resolve(__dirname, '../../../u575589445_orrico/Tables'), path.resolve(__dirname, '../../../../u575589445_orrico/Tables')]
    .find(dir => dir && fs.existsSync(path.join(dir, 'login.sql')));
if (!schemaDir) { console.error('No se encontró u575589445_orrico/Tables; defina NC5_SCHEMA_DIR.'); process.exit(2); }
const TABLES = ['business', 'rol', 'login', 'cat_permission', 'permission_rol', 'business_role_permission', 'person', 'tracing'];

const results = [];
async function step(name, fn) {
    try { await fn(); results.push(['PASS', name]); } catch (error) { results.push(['FAIL', name, error.stack || error.message]); }
}
async function rejectsCode(promise, code) {
    try { await promise; } catch (error) { assert.equal(error.code, code, error.message); return; }
    throw new Error('Se esperaba ' + code);
}

const A = 'biz-alameda', B = 'biz-norte';
const PERMS = ['px.tab.monitoring', 'tracing.create', 'px.all', 'px.dates', 'admin.config'];
const ROLES = {
    profesional: ['px.tab.monitoring', 'tracing.create', 'px.all', 'px.dates'],
    asistente: ['px.all', 'px.dates'],
    recepcion: ['px.dates'],
    colega: [],
    super_admin: []
};
const USERS = [
    ['valeria', A, 'profesional', 'Valeria Mendoza'], ['sofia', A, 'asistente', 'Sofía Herrera'], ['agenda', A, 'recepcion', 'Sintetic Agenda'],
    ['colega', A, 'colega', 'Carlos Ortega'], ['baja', A, 'colega', 'Persona Inactiva', 0], ['bloq', A, 'colega', 'Persona Bloqueada', 1, 1],
    ['root', A, 'super_admin', 'Super Admin'],
    ['valeria-b', B, 'profesional', 'Valeria Mendoza'], ['sofia-b', B, 'asistente', 'Sofía Herrera']
];

async function setup() {
    const root = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.NC5_QA_PORT), user: 'root', password: 'isolated-test-only', multipleStatements: true });
    await root.query(`DROP DATABASE IF EXISTS ${DATABASE}; CREATE DATABASE ${DATABASE} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; USE ${DATABASE}; SET FOREIGN_KEY_CHECKS=0;`);
    for (const table of TABLES) await root.query(fs.readFileSync(path.join(schemaDir, table + '.sql'), 'utf8'));
    await root.query('SET FOREIGN_KEY_CHECKS=1');
    await root.query('INSERT INTO business (id_business, name, slug) VALUES (?,?,?),(?,?,?)', [A, 'Alameda', 'alameda', B, 'Norte', 'norte']);
    for (const role of Object.keys(ROLES)) await root.query('INSERT INTO rol (id_rol, code, active) VALUES (?,?,1)', ['rol-' + role, role]);
    for (const code of PERMS) await root.query('INSERT INTO cat_permission (id_cat_permission, code, name, description) VALUES (?,?,?,?)', ['perm-' + code, code, code, code]);
    for (const [role, codes] of Object.entries(ROLES)) {
        for (const code of codes) await root.query('INSERT INTO permission_rol (id_permission_rol, id_cat_permission, id_rol, active) VALUES (?,?,?,1)', [`pr-${role}-${code}`, 'perm-' + code, 'rol-' + role]);
    }
    for (const [id, business, role, name, active = 1, locked = 0] of USERS) {
        await root.query('INSERT INTO login (id_login, id_business, id_rol, name, email, active, locked) VALUES (?,?,?,?,?,?,?)', [id, business, 'rol-' + role, name, id + '@qa.invalid', active, locked]);
    }
    await root.query("INSERT INTO person (id_person, id_business, code, name, surname) VALUES ('px-a', ?, 'P0001', 'María', 'García López'), ('px-b', ?, 'P0002', 'Lucía', 'Pérez')", [A, B]);
    await root.query(`INSERT INTO tracing (id_tracing, id_business, treatment_now, treatment_after, note, id_person, quote_date_now, status) VALUES
        ('tr-a', ?, 'Resina oclusal', 'Revisión', 'Texto clínico confidencial', 'px-a', '2026-11-20', 'active'),
        ('tr-a-cancel', ?, 'x', 'x', 'x', 'px-a', '2026-11-19', 'cancelled'),
        ('tr-b', ?, 'x', 'x', 'x', 'px-b', '2026-11-20', 'active')`, [A, A, B]);
    const migration = require('../migrations/nc5-internal-chat');
    const first = await migration.apply(root);
    const second = await migration.apply(root);
    assert.equal(first.alreadyApplied, true);
    assert.equal(second.alreadyApplied, true);
    return root;
}

let counter = 0;
const rid = () => 'qa-request-' + String(++counter).padStart(4, '0');

async function main() {
    const root = await setup();
    const chat = require('../../src/Dao/mysql/chat.dao');
    const sequelize = require('../../src/db/Sequelize.connection');
    const context = { kind: 'tracing', patientId: 'px-a', tracingId: 'tr-a' };

    await step('C9 directorio sin historial: equipo activo por nombre, sin uno mismo, inactivos, bloqueados ni super_admin', async () => {
        const { items } = await chat.directory(A, 'valeria');
        assert.deepEqual(items.map(p => p.id), ['colega', 'agenda', 'sofia']);
        assert.ok(items.every(p => !p.frequent));
    });

    await step('C1 envío manual y respuesta desde la otra sesión; no leídos y lectura', async () => {
        const sent = await chat.sendText(A, 'valeria', { recipientId: 'sofia', clientRequestId: rid(), body: 'Hola Sofía' });
        assert.equal(sent.replayed, false);
        assert.equal((await chat.summary(A, 'sofia')).unread, 1);
        const thread = await chat.messages(A, 'sofia', 'valeria', {});
        assert.deepEqual(thread.items.map(m => m.body), ['Hola Sofía']);
        await chat.markRead(A, 'sofia', 'valeria', thread.items[0].id);
        assert.equal((await chat.summary(A, 'sofia')).unread, 0);
        await chat.sendText(A, 'sofia', { recipientId: 'valeria', clientRequestId: rid(), body: 'Recibido' });
        const mine = await chat.messages(A, 'valeria', 'sofia', { after: thread.items[0].id });
        assert.deepEqual(mine.items.map(m => [m.body, m.mine]), [['Recibido', false]]);
        assert.equal(mine.readUpTo, thread.items[0].id);
    });

    await step('C2/C3 aviso desde nota simulada a asistente que también es recepción', async () => {
        const preview = await chat.previewNotice(A, 'valeria', { recipientId: 'sofia', context, reason: 'control' });
        assert.equal(preview.notice.patient.name, 'María García López');
        assert.equal(preview.notice.canCoordinate, true);
        const sent = await chat.sendNotice(A, 'valeria', { recipientId: 'sofia', clientRequestId: rid(), context, reason: 'control' });
        assert.equal(sent.kind, 'team_notice');
        const thread = await chat.messages(A, 'sofia', 'valeria', {});
        const notice = thread.items.find(m => m.kind === 'team_notice');
        assert.equal(notice.notice.patient.code, 'P0001');
        assert.equal(notice.notice.professional, 'Valeria Mendoza');
        assert.ok(!JSON.stringify(thread).includes('confidencial') && !JSON.stringify(thread).includes('Resina'));
    });

    await step('C4 colega sin Agenda recibe aviso con iniciales y sin coordinar', async () => {
        await chat.sendNotice(A, 'valeria', { recipientId: 'colega', clientRequestId: rid(), context, reason: 'revision' });
        const notice = (await chat.messages(A, 'colega', 'valeria', {})).items[0].notice;
        assert.deepEqual(notice.patient, { name: 'M. G. L.', code: null, restricted: true });
        assert.equal(notice.canCoordinate, false);
        assert.equal(notice.reference, null);
    });

    await step('C5 recepción solo con Agenda ve paciente y puede coordinar', async () => {
        await chat.sendNotice(A, 'valeria', { recipientId: 'agenda', clientRequestId: rid(), context, reason: 'tratamiento' });
        const notice = (await chat.messages(A, 'agenda', 'valeria', {})).items[0].notice;
        assert.equal(notice.patient.name, 'María García López');
        assert.equal(notice.canCoordinate, true);
    });

    await step('C5b recepción sin seguimientos no puede emitir avisos de nota', async () => {
        await rejectsCode(chat.sendNotice(A, 'agenda', { recipientId: 'sofia', clientRequestId: rid(), context, reason: 'control' }), 'CHAT_CONTEXT_FORBIDDEN');
    });

    await step('C7 reintento con el mismo identificador no duplica; con otro contenido es conflicto', async () => {
        const id = rid();
        const first = await chat.sendText(A, 'valeria', { recipientId: 'agenda', clientRequestId: id, body: 'Reintento' });
        const again = await chat.sendText(A, 'valeria', { recipientId: 'agenda', clientRequestId: id, body: 'Reintento' });
        assert.equal(again.replayed, true);
        assert.equal(again.messageId, first.messageId);
        await rejectsCode(chat.sendText(A, 'valeria', { recipientId: 'agenda', clientRequestId: id, body: 'Otro' }), 'CHAT_REQUEST_CONFLICT');
        const recovered = await chat.request(A, 'valeria', id);
        assert.equal(recovered.found, true);
        assert.equal(recovered.message.messageId, first.messageId);
        assert.equal((await chat.request(A, 'sofia', id)).found, false);
        const [[count]] = await root.query(`SELECT COUNT(*) AS n FROM ${DATABASE}.chat_message WHERE client_request_id = ?`, [id]);
        assert.equal(Number(count.n), 1);
    });

    await step('C6 cancelar no escribe: un identificador nunca enviado no existe', async () => {
        assert.equal((await chat.request(A, 'valeria', 'qa-never-sent-0001')).found, false);
    });

    await step('C9 frecuentes: dos con más mensajes primero, el resto por nombre, sin duplicados', async () => {
        const { items } = await chat.directory(A, 'valeria');
        // valeria → agenda 2 y sofía 2 (empate: el envío más reciente fue a agenda), colega 1; el reintento no cuenta.
        assert.deepEqual(items.map(p => [p.id, p.frequent]), [['agenda', true], ['sofia', true], ['colega', false]]);
        const sofia = await chat.directory(A, 'sofia');
        assert.deepEqual(sofia.items.map(p => [p.id, p.frequent]), [['valeria', true], ['colega', false], ['agenda', false]]);
    });

    await step('Validaciones: destinatario propio, inactivo, bloqueado, de otro negocio; nota cancelada o ajena', async () => {
        for (const recipientId of ['valeria', 'baja', 'bloq', 'root', 'sofia-b', 'nadie']) {
            await rejectsCode(chat.sendText(A, 'valeria', { recipientId, clientRequestId: rid(), body: 'x' }), 'CHAT_RECIPIENT_INVALID');
        }
        await rejectsCode(chat.sendNotice(A, 'valeria', { recipientId: 'sofia', clientRequestId: rid(), context: { ...context, tracingId: 'tr-a-cancel' }, reason: 'control' }), 'CHAT_CONTEXT_INVALID');
        await rejectsCode(chat.sendNotice(A, 'valeria', { recipientId: 'sofia', clientRequestId: rid(), context: { kind: 'tracing', patientId: 'px-b', tracingId: 'tr-b' }, reason: 'control' }), 'CHAT_CONTEXT_INVALID');
        await rejectsCode(chat.sendNotice(A, 'valeria', { recipientId: 'sofia', clientRequestId: rid(), context, reason: 'libre' }), 'CHAT_REASON_INVALID');
        await rejectsCode(chat.sendText(A, 'valeria', { recipientId: 'sofia', clientRequestId: rid(), body: '   ' }), 'CHAT_BODY_INVALID');
    });

    await step('C8 mismas dos personas en dos negocios: todo aislado', async () => {
        assert.deepEqual((await chat.conversations(B, 'valeria-b')).items, []);
        assert.equal((await chat.summary(B, 'sofia-b')).unread, 0);
        assert.deepEqual((await chat.directory(B, 'valeria-b')).items.map(p => [p.id, p.frequent]), [['sofia-b', false]]);
        await chat.sendText(B, 'valeria-b', { recipientId: 'sofia-b', clientRequestId: 'qa-request-0001', body: 'Hola en Norte' });
        assert.equal((await chat.summary(B, 'sofia-b')).unread, 1);
        const before = await chat.summary(A, 'sofia');
        await chat.sendText(B, 'valeria-b', { recipientId: 'sofia-b', clientRequestId: rid(), body: 'Otro en Norte' });
        assert.deepEqual(await chat.summary(A, 'sofia'), before);
        await rejectsCode(chat.messages(B, 'valeria-b', 'sofia', {}), 'CHAT_RECIPIENT_INVALID');
        await rejectsCode(chat.messages(A, 'valeria', 'sofia-b', {}), 'CHAT_RECIPIENT_INVALID');
        const read = await chat.markRead(A, 'sofia', 'valeria-b', 999999);
        assert.equal(read.marked, 0);
        assert.equal((await chat.summary(B, 'sofia-b')).unread, 2);
        assert.equal((await chat.request(A, 'valeria', 'qa-request-0001')).message.body, 'Hola Sofía');
        assert.equal((await chat.noticesForTracing(B, 'valeria-b', 'tr-a')).items.length, 0);
    });

    await step('Bandeja y avisos de la nota: estados de enviado y leído independientes', async () => {
        const inbox = await chat.conversations(A, 'valeria');
        assert.deepEqual(inbox.items.map(c => c.peer.id).sort(), ['agenda', 'colega', 'sofia']);
        const notices = await chat.noticesForTracing(A, 'valeria', 'tr-a');
        assert.equal(notices.items.length, 3);
        assert.ok(notices.items.every(n => n.sentAt && n.readAt === null) || notices.items.some(n => n.readAt));
        const thread = await chat.messages(A, 'colega', 'valeria', {});
        await chat.markRead(A, 'colega', 'valeria', thread.items[thread.items.length - 1].id);
        const after = await chat.noticesForTracing(A, 'valeria', 'tr-a');
        assert.ok(after.items.find(n => n.recipient.id === 'colega').readAt);
        const [[row]] = await root.query(`SELECT status FROM ${DATABASE}.tracing WHERE id_tracing = 'tr-a'`);
        assert.equal(row.status, 'active');
    });

    await step('Migración: revertir respalda filas y elimina la tabla; reaplicar la recrea', async () => {
        const migration = require('../migrations/nc5-internal-chat');
        const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nc5-chat-'));
        const reverted = await migration.revert(root, dir);
        assert.equal(reverted.alreadyApplied, false);
        assert.ok(reverted.backedUpRows > 5);
        assert.ok(fs.existsSync(path.join(dir, 'chat-message-rows.json')));
        assert.equal((await migration.apply(root)).alreadyApplied, true);
    });

    await sequelize.close();
    await root.end();
    for (const [status, name, detail] of results) console.log(`${status} ${name}${detail ? '\n' + detail : ''}`);
    const failed = results.filter(row => row[0] === 'FAIL').length;
    console.log(`\n${results.length - failed}/${results.length} PASS`);
    process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });

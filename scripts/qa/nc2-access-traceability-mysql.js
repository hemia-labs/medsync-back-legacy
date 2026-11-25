'use strict';
// NC2 · Trazabilidad de accesos al expediente contra MySQL aislado con el DDL exportado del workspace.
// Usa controladores y DAO reales; la sesión autenticada se representa con tokenDecode, igual que tras Token.Auth.
// Lo invoca nc2-access-traceability.docker.sh. Se niega a correr sin NC2_QA_ISOLATED=1.
// Los casos «BRECHA» documentan el comportamiento actual: pasan mientras la brecha exista.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

if (process.env.NC2_QA_ISOLATED !== '1' || !process.env.NC2_QA_PORT) {
    console.error('Solo en MySQL aislado: defina NC2_QA_ISOLATED=1 y NC2_QA_PORT (use nc2-access-traceability.docker.sh).');
    process.exit(2);
}
// El prefijo nc1_qa_ permite aplicar la migración de identidad NC1 (patient_identity), ausente del DDL exportado.
const DATABASE = 'nc1_qa_nc2_access';
const PASSWORD = 'isolated-test-only';
Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: process.env.NC2_QA_PORT, DB_USER: 'root', DB_PASSWORD: PASSWORD, DB_NAME: DATABASE });
// Respaldo durable de lecturas (cola con alerta) en un directorio temporal y canal de Soporte local controlable.
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const SPOOL = fs.mkdtempSync(path.join(os.tmpdir(), 'nc2-access-spool-'));
Object.assign(process.env, { ACCESS_AUDIT_SPOOL_DIR: SPOOL, ACCESS_AUDIT_ENV: 'nc2-qa', ACCESS_AUDIT_ALERT_BACKOFF_MS: '200', ACCESS_AUDIT_START_RETRY_MS: '300' });
const hook = { fail: false, received: [] };
const hookServer = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => { if (hook.fail) { res.statusCode = 503; return res.end(); } hook.received.push(JSON.parse(body)); res.end('{}'); });
});

const schemaDir = [process.env.NC2_SCHEMA_DIR, path.resolve(__dirname, '../../../u575589445_orrico/Tables'), path.resolve(__dirname, '../../../../u575589445_orrico/Tables')]
    .find(dir => dir && fs.existsSync(path.join(dir, 'login.sql')));
if (!schemaDir) { console.error('No se encontró u575589445_orrico/Tables; defina NC2_SCHEMA_DIR.'); process.exit(2); }

const A = 'biz-alameda', B = 'biz-norte';
const MARK = { history: 'NC2-HISTORIA-CLINICA-SINTETICA', old: 'NC2-VERSION-ANTERIOR-SINTETICA', doc: 'NC2-DOCUMENTO-SINTETICO',
    rx: 'NC2-DIAGNOSTICO-RECETA-SINTETICO', item: 'NC2-MEDICAMENTO-SINTETICO' };
const PERMS = ['clinical_history.view', 'clinical_history.view_sensitive', 'clinical_history.print', 'documents.view',
    'prescriptions.view.all', 'prescriptions.print', 'prescriptions.download', 'px.tab.photos', 'px.radiography'];
const ROLES = { doctor: PERMS, recepcion: [] };
const USERS = [['valeria', A, 'doctor', 'Valeria Mendoza'], ['agenda', A, 'recepcion', 'Recepción Sintética'], ['valeria-b', B, 'doctor', 'Profesional Norte']];
const session = id => { const [login, business, rol] = USERS.find(u => u[0] === id); return { id_login: login, id_business: business, rol }; };

const results = [];
async function step(id, name, fn) {
    try { const note = await fn(); results.push({ id, result: 'PASS', name, ...(note ? { note } : {}) }); }
    catch (error) { results.push({ id, result: 'FAIL', name, error: error.message }); }
}

let root;
async function setup() {
    root = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.NC2_QA_PORT), user: 'root', password: PASSWORD, multipleStatements: true });
    await root.query(`DROP DATABASE IF EXISTS ${DATABASE}; CREATE DATABASE ${DATABASE} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; USE ${DATABASE}; SET FOREIGN_KEY_CHECKS=0;`);
    for (const file of fs.readdirSync(schemaDir).filter(f => f.endsWith('.sql')).sort()) await root.query(fs.readFileSync(path.join(schemaDir, file), 'utf8'));
    await root.query('SET FOREIGN_KEY_CHECKS=1');
    await require('../migrations/nc1-identity').apply(root, { isolated: true });
    await root.query('INSERT INTO business (id_business, name, slug) VALUES (?,?,?),(?,?,?)', [A, 'Alameda', 'alameda', B, 'Norte', 'norte']);
    for (const role of Object.keys(ROLES)) await root.query('INSERT INTO rol (id_rol, code, active) VALUES (?,?,1)', ['rol-' + role, role]);
    for (const code of PERMS) await root.query('INSERT INTO cat_permission (id_cat_permission, code, name, description, active, is_active) VALUES (?,?,?,?,1,1)', ['perm-' + code, code, code, code]);
    for (const [role, codes] of Object.entries(ROLES)) for (const code of codes) {
        await root.query('INSERT INTO permission_rol (id_permission_rol, id_cat_permission, id_rol, active) VALUES (?,?,?,1)', [`pr-${role}-${code}`, 'perm-' + code, 'rol-' + role]);
    }
    for (const [id, business, role, name] of USERS) {
        await root.query('INSERT INTO login (id_login, id_business, id_rol, name, email, active) VALUES (?,?,?,?,?,1)', [id, business, 'rol-' + role, name, id + '@qa.invalid']);
    }
    await root.query("INSERT INTO person (id_person, id_business, code, name, surname, active) VALUES ('px-a', ?, 'P0001', 'Paciente', 'Sintética NC2', 1)", [A]);
    // Historia: v1 sustituida y v2 finalizada, con texto clínico identificable para comprobar que no llega a la bitácora.
    await root.query(`INSERT INTO clinical_histories (id_clinical_history, business_id, patient_id, created_by_user_id, clinical_snapshot_json, status, version_number, created_at)
        VALUES ('ch-a-v1', ?, 'px-a', 'valeria', ?, 'SUPERSEDED', 1, NOW() - INTERVAL 1 DAY), ('ch-a-v2', ?, 'px-a', 'valeria', ?, 'FINALIZED', 2, NOW())`,
        [A, JSON.stringify({ motivo: MARK.old }), A, JSON.stringify({ motivo: MARK.history })]);
    await root.query(`INSERT INTO patient_documents (id_patient_document, id_business, id_person, document_type, title, status, content_html_snapshot, active)
        VALUES ('doc-a', ?, 'px-a', 'GENERAL', 'Consentimiento sintético', 'FIRMADO', ?, 1)`, [A, `<p>${MARK.doc}</p>`]);
    await root.query(`INSERT INTO prescription (id_prescription, id_business, id_person, issuer_doctor_id, created_by, folio, issue_date, status, diagnosis, active)
        VALUES ('rx-a', ?, 'px-a', 'valeria', 'valeria', 'RX-NC2-0001', CURDATE(), 'issued', ?, 1)`, [A, MARK.rx]);
    await root.query(`INSERT INTO prescription_item (id_prescription_item, id_prescription, id_business, generic_name, dose, administration_route, frequency, duration)
        VALUES ('rxi-a', 'rx-a', ?, ?, '1 tableta', 'oral', 'cada 8 h', '3 días')`, [A, MARK.item]);
    await root.query("INSERT INTO cat_files (id_cat_files, code, description, active) VALUES ('cf-photo', 'C4CA42', 'Fotografías', 1)");
    await root.query("INSERT INTO files (id_files, id_cat_files, id_person, url, active, id_business) VALUES ('file-a', 'cf-photo', 'px-a', 'https://bucket-sintetico.invalid/px-a/foto.jpg', 1, ?)", [A]);
}

const count = async (sql, params = []) => Number((await root.query(sql, params))[0][0].total);
const historyEvents = (extra = '') => count(`SELECT COUNT(*) AS total FROM clinical_history_events WHERE business_id = ? ${extra}`, [A]);
const documentEvents = () => count('SELECT COUNT(*) AS total FROM patient_document_events WHERE id_business = ?', [A]);
const prescriptionAudit = (action) => count('SELECT COUNT(*) AS total FROM prescription_audit_log WHERE id_business = ?' + (action ? ' AND action = ?' : ''), action ? [A, action] : [A]);

async function call(handler, user, { params = {}, body = {}, query = {} } = {}) {
    let status, payload;
    const res = { status(code) { status = code; return this; }, send(value) { payload = value; return this; }, set() { return this; }, json(value) { payload = value; return this; } };
    const req = { tokenDecode: session(user), params, body, query, patientFileCodes: ['C4CA42'] };
    await handler(req, res, error => { throw error; });
    return { status, payload, text: JSON.stringify(payload || null) };
}

// Simula que el almacén de eventos rechaza escrituras sin afectar las lecturas.
async function withEventWritesFailing(table, fn) {
    await root.query(`CREATE TRIGGER nc2_reject_${table} BEFORE INSERT ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'NC2 synthetic audit storage failure'`);
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    try { return await fn(logged); } finally { console.error = original; await root.query(`DROP TRIGGER nc2_reject_${table}`); }
}

const noClinicalText = text => { for (const mark of Object.values(MARK)) assert.ok(!text.includes(mark), 'contenido clínico presente: ' + mark); };

const spoolModule = () => require('../../src/services/accessAuditSpool');
const pendingDir = path.join(SPOOL, 'pending');
const pendingFiles = () => (fs.existsSync(pendingDir) && fs.statSync(pendingDir).isDirectory() ? fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')).sort() : []);
const readPending = names => names.map(n => ({ raw: fs.readFileSync(path.join(pendingDir, n), 'utf8') })).map(f => ({ ...f, event: JSON.parse(f.raw) }));
const newSince = before => pendingFiles().filter(f => !before.includes(f));
const SPOOL_FIELDS = ['actor', 'at', 'business', 'context', 'failure', 'id', 'kind', 'resource', 'v'];
const wait = ms => new Promise(r => setTimeout(r, ms));
// Reinicio real: otro proceso de Node, sin memoria compartida, vacía el respaldo leyendo sólo el disco.
const drainInChildProcess = ({ dir = SPOOL, alertOk = true } = {}) => JSON.parse(execFileSync(process.execPath, ['-e',
    `const s=require('./src/services/accessAuditSpool').createAccessAuditSpool({alert:async()=>({ok:${alertOk},channel:'qa'})});` +
    "s.drain().then(r=>{process.stdout.write('\\n'+JSON.stringify(r));return require('./src/db/Sequelize.connection').close();})"],
    { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, ACCESS_AUDIT_SPOOL_DIR: dir }, encoding: 'utf8' }).trim().split('\n').pop());
const readOutbox = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'alerts', 'outbox.json'), 'utf8')); } catch { return []; } };
async function captureErrors(fn) {
    const logged = [], original = console.error;
    console.error = (...args) => logged.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    try { return { value: await fn(), logged }; } finally { console.error = original; }
}

async function main() {
    await setup();
    await new Promise(r => hookServer.listen(0, '127.0.0.1', r));
    process.env.ACCESS_AUDIT_ALERT_WEBHOOK_URL = 'http://127.0.0.1:' + hookServer.address().port + '/soporte';
    if (process.env.NC2_DEBUG === '1') { // Solo diagnóstico local con datos sintéticos: muestra el mensaje del driver.
        const mod = require('../../src/util/sequelizeException'); const original = mod.SequelizeException;
        mod.SequelizeException = (error, message) => { console.log('NC2_DEBUG', error && error.message); return original(error, message); };
    }
    const History = require('../../src/controller/mysql/clinicalHistory.controller');
    const Documents = require('../../src/controller/mysql/document.controller');
    const Prescriptions = require('../../src/controller/mysql/prescription.controller');
    const Files = require('../../src/controller/mysql/files.controller');

    // 1. Abrir historia (vigente) y consultar una versión anterior.
    await step('H1', 'Profesional abre la historia vigente: 200 y evento VIEWED con actor y consultorio de la sesión', async () => {
        const r = await call(History.latestByPatient, 'valeria', { params: { patientId: 'px-a' }, body: { id_login: 'forjado', id_business: B } });
        assert.equal(r.status, 200); assert.ok(r.text.includes(MARK.history));
        const [rows] = await root.query("SELECT * FROM clinical_history_events WHERE business_id = ? AND event_type = 'VIEWED'", [A]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].user_id, 'valeria'); assert.equal(rows[0].clinical_history_id, 'ch-a-v2'); assert.equal(rows[0].patient_id, 'px-a');
        assert.ok(rows[0].created_at instanceof Date);
        assert.deepEqual(JSON.parse(rows[0].metadata_json), { context: 'patient_latest' });
        return { evento: { tabla: 'clinical_history_events', event_type: 'VIEWED', user_id: rows[0].user_id, business_id: rows[0].business_id, recurso: rows[0].clinical_history_id, metadata: rows[0].metadata_json } };
    });
    await step('H2', 'Lista de versiones: solo metadatos, sin texto clínico y sin evento', async () => {
        const before = await historyEvents();
        const r = await call(History.versionsByPatient, 'valeria', { params: { patientId: 'px-a' } });
        assert.equal(r.status, 200); noClinicalText(r.text);
        assert.equal(await historyEvents(), before);
    });
    await step('H3', 'Consultar la versión anterior: 200 y VIEWED sobre esa versión (contexto detail)', async () => {
        const r = await call(History.getById, 'valeria', { params: { id: 'ch-a-v1' } });
        assert.equal(r.status, 200); assert.ok(r.text.includes(MARK.old));
        const [rows] = await root.query("SELECT user_id, metadata_json FROM clinical_history_events WHERE clinical_history_id = 'ch-a-v1' AND event_type = 'VIEWED'");
        assert.equal(rows.length, 1); assert.equal(rows[0].user_id, 'valeria'); assert.deepEqual(JSON.parse(rows[0].metadata_json), { context: 'detail' });
    });
    await step('H4', 'Imprimir historia: PRINTED con estado y versión, sin texto clínico en metadatos', async () => {
        const r = await call(History.printed, 'valeria', { params: { id: 'ch-a-v2' } });
        assert.equal(r.status, 200);
        const [rows] = await root.query("SELECT metadata_json FROM clinical_history_events WHERE clinical_history_id = 'ch-a-v2' AND event_type = 'PRINTED'");
        assert.equal(rows.length, 1); noClinicalText(rows[0].metadata_json);
        assert.equal(JSON.parse(rows[0].metadata_json).version_number, 2);
    });
    await step('H5', 'Recepción sin permiso: 403 sin contenido clínico y sin evento', async () => {
        const before = await historyEvents();
        for (const r of [await call(History.getById, 'agenda', { params: { id: 'ch-a-v2' } }), await call(History.latestByPatient, 'agenda', { params: { patientId: 'px-a' } })]) {
            assert.equal(r.status, 403); noClinicalText(r.text);
        }
        assert.equal(await historyEvents(), before);
    });
    await step('H6', 'Profesional de otro consultorio: rechazo sin contenido clínico y sin evento', async () => {
        const before = await historyEvents();
        for (const r of [await call(History.getById, 'valeria-b', { params: { id: 'ch-a-v2' } }), await call(History.latestByPatient, 'valeria-b', { params: { patientId: 'px-a' } })]) {
            assert.notEqual(r.status, 200); noClinicalText(r.text);
        }
        assert.equal(await historyEvents(), before);
        return 'Las denegaciones no dejan evento clínico; solo la línea HTTP de morgan sin actor.';
    });
    await step('H7', 'Falla la bitácora al abrir la historia o una versión: entrega el contenido sólo con cada acceso respaldado en disco, sin texto clínico', async () => {
        return withEventWritesFailing('clinical_history_events', async () => {
            const before = pendingFiles(), rows = await historyEvents("AND event_type = 'VIEWED'");
            const latest = await call(History.latestByPatient, 'valeria', { params: { patientId: 'px-a' }, body: { id_login: 'forjado', id_business: B } });
            const version = await call(History.getById, 'valeria', { params: { id: 'ch-a-v1' } });
            assert.equal(latest.status, 200, 'historia vigente: ' + latest.status); assert.ok(latest.text.includes(MARK.history));
            assert.equal(version.status, 200, 'versión: ' + version.status); assert.ok(version.text.includes(MARK.old));
            assert.equal(await historyEvents("AND event_type = 'VIEWED'"), rows, 'la bitácora no debía aceptar escrituras');
            const spooled = readPending(newSince(before));
            assert.equal(spooled.length, 2, 'accesos respaldados: ' + spooled.length);
            for (const { raw, event } of spooled) {
                noClinicalText(raw); assert.ok(!/token|https?:/i.test(raw), 'sin tokens ni URL');
                assert.deepEqual(Object.keys(event).filter(k => k !== 'patient').sort(), SPOOL_FIELDS);
                assert.deepEqual([event.kind, event.actor, event.business, event.patient], ['clinical_history_view', 'valeria', A, 'px-a']);
            }
            assert.deepEqual(spooled.map(s => [s.event.resource, s.event.context]).sort(), [['ch-a-v1', 'detail'], ['ch-a-v2', 'patient_latest']]);
            return { respaldo: spooled.map(s => s.event) };
        });
    });

    // 2. Documento: listado, detalle, observación VIEWED/PRINTED declarada por el cliente.
    await step('D1', 'BRECHA: el detalle del documento entrega el contenido sin evento del servidor', async () => {
        const before = await documentEvents();
        const r = await call(Documents.PatientDocuments, 'valeria', { params: { id_person: 'px-a', id_patient_document: 'doc-a' } });
        assert.equal(r.status, 200); assert.ok(r.text.includes(MARK.doc));
        assert.equal(await documentEvents(), before);
    });
    await step('D2', 'BRECHA: el listado paginado ya incluye el contenido de cada documento, sin evento', async () => {
        const before = await documentEvents();
        const r = await call(Documents.PatientDocuments, 'valeria', { params: { id_person: 'px-a' }, query: { page: '1', page_size: '10' } });
        assert.equal(r.status, 200); assert.ok(r.text.includes(MARK.doc));
        assert.equal(await documentEvents(), before);
    });
    await step('D3', 'Ver e Imprimir del cliente: VIEWED y PRINTED con actor y consultorio de la sesión aunque el cuerpo los falsifique', async () => {
        for (const event_type of ['VIEWED', 'PRINTED']) {
            const r = await call(Documents.AuditAction, 'valeria', { body: { id_patient_document: 'doc-a', event_type, id_login: 'forjado', id_business: B } });
            assert.equal(r.status, 200);
        }
        const [rows] = await root.query('SELECT event_type, created_by, id_business, notes FROM patient_document_events ORDER BY event_type');
        assert.deepEqual(rows.map(r => [r.event_type, r.created_by, r.id_business, r.notes]), [['PRINTED', 'valeria', A, null], ['VIEWED', 'valeria', A, null]]);
    });
    await step('D4', 'Recepción sin documents.view: 403 sin contenido en listado y detalle', async () => {
        for (const params of [{ id_person: 'px-a' }, { id_person: 'px-a', id_patient_document: 'doc-a' }]) {
            const r = await call(Documents.PatientDocuments, 'agenda', { params }); assert.equal(r.status, 403); noClinicalText(r.text);
        }
    });
    await step('D5', 'Otro consultorio: no lee el documento ni puede escribir evidencia sobre él', async () => {
        const before = await documentEvents();
        const read = await call(Documents.PatientDocuments, 'valeria-b', { params: { id_person: 'px-a', id_patient_document: 'doc-a' } });
        assert.notEqual(read.status, 200); noClinicalText(read.text);
        const write = await call(Documents.AuditAction, 'valeria-b', { body: { id_patient_document: 'doc-a', event_type: 'VIEWED' } });
        assert.notEqual(write.status, 200);
        assert.equal(await documentEvents(), before);
    });
    await step('D6', 'Falla de escritura de VIEWED: la API responde error, pero el contenido ya se entregó en la lectura previa', async () => {
        return withEventWritesFailing('patient_document_events', async logged => {
            const read = await call(Documents.PatientDocuments, 'valeria', { params: { id_person: 'px-a', id_patient_document: 'doc-a' } });
            assert.equal(read.status, 200); assert.ok(read.text.includes(MARK.doc));
            const r = await call(Documents.AuditAction, 'valeria', { body: { id_patient_document: 'doc-a', event_type: 'VIEWED' } });
            assert.notEqual(r.status, 200);
            return { status: r.status, log: logged.find(line => line.includes('[DATABASE_OPERATION_FAILED]')) || null };
        });
    });

    // 3. Archivo del paciente.
    await step('F1', 'BRECHA: la lista de archivos emite la URL guardada del objeto sin evento; la entrega ocurre fuera de MedSync', async () => {
        const before = { h: await historyEvents(), d: await documentEvents(), p: await prescriptionAudit() };
        const r = await call(Files.getfilesPhoto, 'valeria', { params: { px: 'px-a' } });
        assert.equal(r.status, 200); assert.ok(r.text.includes('https://bucket-sintetico.invalid/px-a/foto.jpg'));
        assert.deepEqual({ h: await historyEvents(), d: await documentEvents(), p: await prescriptionAudit() }, before);
        const foreign = await call(Files.getfilesPhoto, 'valeria-b', { params: { px: 'px-a' } });
        assert.notEqual(foreign.status, 200); assert.ok(!foreign.text.includes('bucket-sintetico'));
    });

    // 4. Receta: consulta (vista previa), impresión y PDF.
    await step('R1', 'Consultar una receta (vista previa) deja evento viewed con actor y consultorio de la sesión', async () => {
        const before = await prescriptionAudit('viewed');
        const r = await call(Prescriptions.getById, 'valeria', { params: { id_prescription: 'rx-a' } });
        assert.equal(r.status, 200); assert.ok(r.text.includes(MARK.rx) && r.text.includes(MARK.item));
        const [rows] = await root.query("SELECT id_user, id_business, id_prescription, previous_status, new_status, metadata, reason FROM prescription_audit_log WHERE action = 'viewed'");
        assert.equal(rows.length, before + 1, 'consulta sin evidencia en prescription_audit_log');
        const row = rows[rows.length - 1];
        assert.deepEqual([row.id_user, row.id_business, row.id_prescription, row.previous_status, row.new_status, row.reason], ['valeria', A, 'rx-a', 'issued', 'issued', null]);
        noClinicalText(String(row.metadata));
        return { evento: { tabla: 'prescription_audit_log', action: 'viewed', id_user: row.id_user, id_business: row.id_business, metadata: row.metadata } };
    });
    await step('R2', 'Imprimir y PDF comparten la preparación de salida: printed y downloaded con origen, sin texto clínico', async () => {
        for (const action of ['printed', 'downloaded']) {
            const r = await call(Prescriptions.prepareOutput, 'valeria', { body: { id_prescription: 'rx-a', action, metadata: { source: 'patient_record' } } });
            assert.equal(r.status, 200); assert.ok(r.text.includes(MARK.item));
        }
        const [rows] = await root.query("SELECT action, id_user, id_business, metadata FROM prescription_audit_log WHERE action IN ('printed','downloaded') ORDER BY action");
        assert.deepEqual(rows.map(r => [r.action, r.id_user, r.id_business, JSON.parse(r.metadata).source]), [['downloaded', 'valeria', A, 'patient_record'], ['printed', 'valeria', A, 'patient_record']]);
    });
    await step('R3', 'BRECHA: el listado de recetas incluye diagnóstico y medicamentos sin evento', async () => {
        const before = await prescriptionAudit();
        const r = await call(Prescriptions.listByPatient, 'valeria', { params: { id_person: 'px-a' }, query: {} });
        assert.equal(r.status, 200); assert.ok(r.text.includes(MARK.rx) && r.text.includes(MARK.item));
        assert.equal(await prescriptionAudit(), before);
    });
    await step('R4', 'Recepción sin permiso de recetas: 403 en consulta y salida, sin contenido ni evento', async () => {
        const before = await prescriptionAudit();
        for (const r of [await call(Prescriptions.getById, 'agenda', { params: { id_prescription: 'rx-a' } }),
            await call(Prescriptions.prepareOutput, 'agenda', { body: { id_prescription: 'rx-a', action: 'printed' } })]) {
            assert.equal(r.status, 403); noClinicalText(r.text);
        }
        assert.equal(await prescriptionAudit(), before);
    });
    await step('R5', 'Otro consultorio: no lee ni prepara salida de la receta, sin evento', async () => {
        const before = await prescriptionAudit();
        for (const r of [await call(Prescriptions.getById, 'valeria-b', { params: { id_prescription: 'rx-a' } }),
            await call(Prescriptions.prepareOutput, 'valeria-b', { body: { id_prescription: 'rx-a', action: 'printed' } })]) {
            assert.notEqual(r.status, 200); noClinicalText(r.text);
        }
        assert.equal(await prescriptionAudit(), before);
    });
    await step('R6a', 'Falla la bitácora al consultar la receta: entrega el detalle sólo con el acceso respaldado en disco', async () => {
        return withEventWritesFailing('prescription_audit_log', async () => {
            const before = pendingFiles(), viewed = await prescriptionAudit('viewed');
            const view = await call(Prescriptions.getById, 'valeria', { params: { id_prescription: 'rx-a' } });
            assert.equal(view.status, 200, 'consulta: ' + view.status); assert.ok(view.text.includes(MARK.rx));
            assert.equal(await prescriptionAudit('viewed'), viewed);
            const spooled = readPending(newSince(before));
            assert.equal(spooled.length, 1);
            const { raw, event } = spooled[0];
            noClinicalText(raw); assert.ok(!/token|https?:/i.test(raw));
            assert.deepEqual([event.kind, event.actor, event.business, event.resource, event.status, event.context], ['prescription_view', 'valeria', A, 'rx-a', 'issued', 'detail']);
            return { respaldo: event };
        });
    });
    await step('R6b', 'Falla la bitácora al preparar la salida de receta (imprimir o PDF): sigue bloqueada y no usa el respaldo', async () => {
        return withEventWritesFailing('prescription_audit_log', async logged => {
            const before = pendingFiles();
            const outputs = [];
            for (const action of ['printed', 'downloaded']) outputs.push(await call(Prescriptions.prepareOutput, 'valeria', { body: { id_prescription: 'rx-a', action } }));
            for (const r of outputs) { assert.notEqual(r.status, 200); noClinicalText(r.text); }
            assert.deepEqual(newSince(before), []);
            assert.ok(logged.filter(line => line.includes('[DATABASE_OPERATION_FAILED]')).length >= 2);
            return { salida: outputs.map(r => r.status) };
        });
    });

    // 4b. Cola con alerta: aviso agrupado, fallo doble, reinicio y recuperación, reintento del aviso.
    await step('Q1', 'Aviso a Soporte agrupado por avería: un aviso por bitácora caída aunque haya varios accesos, sin texto clínico ni identificadores de paciente', async () => {
        await spoolModule().shared().deliverAlerts();
        const alerts = hook.received.filter(a => a.code === 'ACCESS_AUDIT_SPOOLED');
        assert.deepEqual(alerts.map(a => a.table).sort(), ['clinical_history_events', 'prescription_audit_log']);
        const raw = JSON.stringify(alerts); noClinicalText(raw);
        assert.ok(!raw.includes('px-a') && !raw.includes('valeria'), 'el aviso no lleva paciente ni actor');
        assert.equal(spoolModule().shared().outages().filter(o => !o.cleared).length, 2);
        return { avisos: alerts.map(a => ({ table: a.table, error: a.error, cycle: a.cycle, pendingAccesses: a.pendingAccesses })) };
    });
    await step('Q2', 'Fallo doble (bitácora y respaldo en disco): la consulta de historia y la de receta se bloquean sin contenido', async () => {
        const aside = pendingDir + '.aside';
        fs.renameSync(pendingDir, aside); fs.writeFileSync(pendingDir, 'no es un directorio'); // el respaldo no puede escribirse
        try {
            const out = {};
            await withEventWritesFailing('clinical_history_events', async logged => {
                const r = await call(History.getById, 'valeria', { params: { id: 'ch-a-v2' } });
                assert.notEqual(r.status, 200); noClinicalText(r.text); assert.ok(r.payload.data && r.payload.data.reference);
                assert.ok(logged.some(l => l.startsWith('NC2_ACCESS_AUDIT_SPOOL_FAILED')), 'línea de fallo del respaldo');
                out.historia = r.status;
            });
            await withEventWritesFailing('prescription_audit_log', async () => {
                const r = await call(Prescriptions.getById, 'valeria', { params: { id_prescription: 'rx-a' } });
                assert.notEqual(r.status, 200); noClinicalText(r.text);
                out.receta = r.status;
            });
            return out;
        } finally { fs.unlinkSync(pendingDir); fs.renameSync(aside, pendingDir); }
    });
    await step('Q3', 'Reinicio y recuperación: otro proceso vacía el respaldo; cada acceso aparece una sola vez, con su identificador y hora original', async () => {
        const spooled = readPending(pendingFiles()).map(s => s.event);
        assert.equal(spooled.length, 3, 'accesos respaldados antes del reinicio: ' + spooled.length);
        await wait(2100); // la hora de inserción quedaría al menos 2 s después del acceso
        const first = drainInChildProcess();
        assert.equal(first.inserted, 3); assert.deepEqual(pendingFiles(), []);
        // Un archivo que reaparece (corte entre insertar y borrar) no duplica el acceso.
        fs.writeFileSync(path.join(pendingDir, 'replay-' + spooled[0].id + '.json'), JSON.stringify(spooled[0]));
        const second = drainInChildProcess();
        assert.deepEqual([second.inserted, second.duplicates], [0, 1]); assert.deepEqual(pendingFiles(), []);
        for (const e of spooled) {
            const sql = e.kind === 'clinical_history_view'
                ? 'SELECT user_id AS actor, business_id AS business, clinical_history_id AS resource, created_at, metadata_json AS meta FROM clinical_history_events WHERE id_clinical_history_event = ?'
                : 'SELECT id_user AS actor, id_business AS business, id_prescription AS resource, created_at, metadata AS meta FROM prescription_audit_log WHERE id_prescription_audit_log = ?';
            const [rows] = await root.query(sql, [e.id]);
            assert.equal(rows.length, 1, 'acceso ' + e.id + ' aparece ' + rows.length + ' veces');
            assert.deepEqual([rows[0].actor, rows[0].business, rows[0].resource], [e.actor, e.business, e.resource]);
            assert.equal(rows[0].created_at.getTime(), Date.parse(e.at), 'hora original');
            assert.deepEqual(JSON.parse(rows[0].meta), { context: e.context });
        }
        // La instancia de la aplicación tras el reinicio sólo conoce lo que hay en disco: las averías quedaron resueltas.
        const restarted = spoolModule().install(spoolModule().createAccessAuditSpool());
        assert.equal(restarted.outages().filter(o => !o.cleared).length, 0);
        return { vaciado: first, repetido: second };
    });
    await step('Q4', 'Falla sólo el aviso a Soporte: la lectura respaldada continúa y el aviso se reintenta hasta entregarse', async () => {
        hook.fail = true;
        const before = hook.received.length;
        const out = await withEventWritesFailing('clinical_history_events', async () => {
            const r = await call(History.getById, 'valeria', { params: { id: 'ch-a-v2' } });
            assert.equal(r.status, 200); assert.ok(r.text.includes(MARK.history));
            await spoolModule().shared().deliverAlerts();
            const open = spoolModule().shared().outages().filter(o => !o.cleared);
            assert.equal(open.length, 1); assert.equal(open[0].cycle, 2, 'ciclo nuevo de la misma avería');
            assert.equal(open[0].delivered, false); assert.ok(open[0].attempts.length >= 1 && open[0].attempts.every(a => !a.ok));
            hook.fail = false;
            await wait(450);
            await spoolModule().shared().deliverAlerts();
            const entry = spoolModule().shared().outages().find(o => o.id === open[0].id && o.cycle === 2);
            assert.equal(entry.delivered, true);
            return { intentos: entry.attempts.map(a => ({ ok: a.ok, status: a.status })) };
        });
        assert.equal(hook.received.length - before, 1, 'un aviso entregado');
        const drained = await spoolModule().shared().drain();
        assert.equal(drained.inserted, 1); assert.deepEqual(pendingFiles(), []);
        return out;
    });

    // 4c. Correcciones de la revisión cruzada de Codex (una prueba dirigida por hallazgo; el contrato del receptor está en
    // nc2-support-receiver-contract.js).
    await step('Q5', 'Hallazgo 2: acceso respaldado sin aviso persistido; tras reiniciar con MySQL sano queda una fila y un aviso lógico, aunque el primer envío falle', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc2-q5-')), previous = spoolModule().shared();
        spoolModule().install(spoolModule().createAccessAuditSpool({ dir }));
        hook.fail = true;
        try {
            fs.writeFileSync(path.join(dir, 'alerts'), 'directorio de avisos indisponible');
            const recorded = await withEventWritesFailing('prescription_audit_log', async logged => {
                const r = await call(Prescriptions.getById, 'valeria', { params: { id_prescription: 'rx-a' } });
                assert.equal(r.status, 200);
                assert.ok(logged.some(l => l.startsWith('NC2_ACCESS_AUDIT_ALERT_QUEUE_FAILED')), 'falla al persistir el aviso');
                return r;
            });
            assert.equal(recorded.status, 200);
            const files = fs.readdirSync(path.join(dir, 'pending')).filter(f => f.endsWith('.json'));
            assert.equal(files.length, 1);
            const event = JSON.parse(fs.readFileSync(path.join(dir, 'pending', files[0]), 'utf8'));
            const rowsFor = async () => Number((await root.query('SELECT COUNT(*) AS n FROM prescription_audit_log WHERE id_prescription_audit_log = ?', [event.id]))[0][0].n);
            // Orden reproducido por Codex: vuelve MySQL, el directorio de avisos sigue caído y el webhook falla. El mismo trabajador
            // vacía: el aviso sólo existe en memoria, así que la evidencia del acceso no puede retirarse.
            const stuck = await captureErrors(() => spoolModule().shared().drain().catch(error => ({ error: error.code || error.message })));
            assert.equal(await rowsFor(), 0, 'sin aviso durable no se retira la evidencia (fila insertada antes de tiempo)');
            assert.equal(fs.readdirSync(path.join(dir, 'pending')).filter(f => f.endsWith('.json')).length, 1, 'el archivo del acceso sigue en disco');
            assert.ok(stuck.logged.some(l => l.startsWith('NC2_ACCESS_AUDIT_ALERT_QUEUE_FAILED')), 'aviso no durable comunicado');
            // Se recupera el directorio y el trabajador reinicia (otro proceso, sólo el disco); el primer envío vuelve a fallar.
            fs.unlinkSync(path.join(dir, 'alerts'));
            const first = drainInChildProcess({ dir, alertOk: false });
            assert.equal(first.inserted, 1, 'fila recuperada');
            let outbox = readOutbox(dir);
            assert.equal(outbox.length, 1, 'aviso lógico persistido antes de retirar la evidencia: ' + outbox.length);
            assert.deepEqual([outbox[0].incident.table, outbox[0].incident.detectedAt, outbox[0].delivered], ['prescription_audit_log', event.at, false]);
            assert.ok(/^INC-[a-f0-9]{12}$/.test(outbox[0].id));
            await wait(450);
            const second = drainInChildProcess({ dir, alertOk: true });
            outbox = readOutbox(dir);
            assert.equal(outbox.length, 1); assert.equal(outbox[0].delivered, true);
            assert.deepEqual(outbox[0].attempts.map(a => a.ok), [false, true]);
            assert.equal(await rowsFor(), 1);
            return { mismoTrabajador: stuck.value, fila: 1, aviso: { id: outbox[0].id, ciclo: outbox[0].cycle, intentos: outbox[0].attempts.map(a => a.ok) }, segundoVaciado: second };
        } finally { hook.fail = false; spoolModule().install(previous); fs.rmSync(dir, { recursive: true, force: true }); }
    });
    await step('Q5b', 'Escritura parcial del archivo de avisos: no retira la evidencia; el mismo trabajador reintenta la entrada en memoria y queda una fila y un aviso aceptado para ese ciclo', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc2-q5b-')), previous = spoolModule().shared();
        const worker = spoolModule().install(spoolModule().createAccessAuditSpool({ dir }));
        const realWrite = fs.writeSync;
        let partialWrites = 0;
        hook.fail = true;
        try {
            // El sistema de archivos acepta sólo 12 bytes de cada escritura del archivo de avisos (sin error).
            fs.writeSync = function (fd, buf) {
                if (typeof buf === 'string' && buf.includes('"ACCESS_AUDIT_SPOOLED"')) { partialWrites++; return realWrite.call(fs, fd, buf.slice(0, 12)); }
                return realWrite.apply(fs, arguments);
            };
            let event;
            try {
                const r = await withEventWritesFailing('prescription_audit_log', () => call(Prescriptions.getById, 'valeria', { params: { id_prescription: 'rx-a' } }));
                assert.equal(r.status, 200);
                const [name] = fs.readdirSync(path.join(dir, 'pending')).filter(f => f.endsWith('.json'));
                event = JSON.parse(fs.readFileSync(path.join(dir, 'pending', name), 'utf8'));
                await captureErrors(() => worker.drain().catch(error => ({ error: error.code || error.message }))); // MySQL ya está sano
            } finally { fs.writeSync = realWrite; }
            assert.ok(partialWrites >= 1, 'se simuló la escritura parcial');
            assert.deepEqual(readOutbox(dir), [], 'archivo de avisos truncado en disco');
            const rowsFor = async () => Number((await root.query('SELECT COUNT(*) AS n FROM prescription_audit_log WHERE id_prescription_audit_log = ?', [event.id]))[0][0].n);
            assert.equal(await rowsFor(), 0, 'con el aviso truncado no se retira la evidencia');
            hook.fail = false;
            await wait(900);
            const retried = await worker.drain(); // el mismo trabajador, sin reiniciar
            assert.equal(retried.inserted, 1); assert.equal(await rowsFor(), 1);
            const restarted = spoolModule().createAccessAuditSpool({ dir }).outages(); // reinicio: sólo el disco
            assert.equal(restarted.length, 1);
            assert.deepEqual([restarted[0].cycle, restarted[0].delivered, restarted[0].incident.table], [1, true, 'prescription_audit_log']);
            const accepted = hook.received.filter(a => a.id === restarted[0].id);
            assert.deepEqual(accepted.map(a => a.cycle), [1], 'un aviso aceptado para ese ciclo');
            return { escriturasParciales: partialWrites, fila: 1, aviso: { id: restarted[0].id, ciclo: 1, intentos: restarted[0].attempts.map(a => a.ok) } };
        } finally { fs.writeSync = realWrite; hook.fail = false; spoolModule().install(previous); fs.rmSync(dir, { recursive: true, force: true }); }
    });
    await step('Q6', 'Hallazgo 3: la lectura interna dentro de una transacción revertida no deja acceso ni respaldo; el GET independiente sigue usando el respaldo y prepara el contenido antes de registrar', async () => {
        const sequelize = require('../../src/db/Sequelize.connection');
        const HistoryDao = require('../../src/Dao/mysql/clinicalHistory.dao');
        const viewed = () => historyEvents("AND event_type = 'VIEWED' AND clinical_history_id = 'ch-a-v2'");
        const internal = async () => {
            const t = await sequelize.transaction();
            try {
                await sequelize.query("UPDATE clinical_histories SET version_number = 99 WHERE id_clinical_history = 'ch-a-v2'", { transaction: t });
                return await HistoryDao.getById({ id_clinical_history: 'ch-a-v2', id_business: A, id_login: 'valeria' }, t);
            } finally { await t.rollback(); }
        };
        const before = pendingFiles(), events = await viewed();
        const failing = await withEventWritesFailing('clinical_history_events', internal);
        assert.notEqual(failing.status, 200, 'con la bitácora caída la respuesta interna no se entrega');
        const healthy = await internal();
        assert.equal(healthy.status, 200);
        const [[version]] = await root.query("SELECT version_number FROM clinical_histories WHERE id_clinical_history = 'ch-a-v2'");
        assert.equal(Number(version.version_number), 2, 'transacción revertida');
        assert.deepEqual(newSince(before), [], 'sin archivos de respaldo');
        await spoolModule().shared().drain();
        assert.equal(await viewed(), events, 'sin VIEWED fuera de la transacción');
        // Si la preparación del contenido falla, no queda un acceso registrado que no se entregó.
        const consent = HistoryDao.getSensitiveConsent;
        HistoryDao.getSensitiveConsent = async () => { throw new Error('NC2 synthetic preparation failure'); };
        let prepared;
        try { prepared = await captureErrors(() => call(History.getById, 'valeria', { params: { id: 'ch-a-v2' } })); }
        finally { HistoryDao.getSensitiveConsent = consent; }
        assert.notEqual(prepared.value.status, 200); noClinicalText(prepared.value.text);
        assert.equal(await viewed(), events, 'sin VIEWED cuando la preparación falla');
        // El GET independiente con la bitácora caída sigue usando el respaldo.
        const independent = await withEventWritesFailing('clinical_history_events', () => call(History.getById, 'valeria', { params: { id: 'ch-a-v2' } }));
        assert.equal(independent.status, 200);
        assert.equal(newSince(before).length, 1);
        assert.equal((await spoolModule().shared().drain()).inserted, 1);
        return { internaConBitacoraCaida: failing.status, internaSana: healthy.status, versionTrasRollback: 2, getIndependiente: independent.status };
    });
    await step('Q7', 'Hallazgo 4: con el directorio de respaldo inutilizable el arranque no lanza; la API sirve con SQL sano, bloquea con ambos caídos y el vaciado reintenta', async () => {
        const blocker = path.join(SPOOL, 'q7-not-a-dir'), previous = spoolModule().shared();
        fs.writeFileSync(blocker, 'x');
        const broken = spoolModule().install(spoolModule().createAccessAuditSpool({ dir: path.join(blocker, 'spool') }));
        try {
            const source = fs.readFileSync(path.resolve(__dirname, '../../src/index.js'), 'utf8');
            assert.ok(source.includes("require('./services/accessAuditSpool').startWorker("), 'src/index.js arranca con startWorker');
            let threw = null;
            const started = await captureErrors(() => { try { return spoolModule().startWorker(60000); } catch (error) { threw = error; return null; } });
            assert.equal(threw, null, 'el arranque no lanza: ' + (threw && threw.code));
            assert.equal(started.value, false);
            assert.ok(started.logged.some(l => l.startsWith('NC2_ACCESS_AUDIT_SPOOL_UNAVAILABLE')), 'indisponibilidad comunicada');
            const events = await historyEvents("AND event_type = 'VIEWED'");
            const served = await call(History.getById, 'valeria', { params: { id: 'ch-a-v2' } });
            assert.equal(served.status, 200); assert.equal(await historyEvents("AND event_type = 'VIEWED'"), events + 1, 'evento en MySQL');
            const blocked = await withEventWritesFailing('clinical_history_events', () => call(History.getById, 'valeria', { params: { id: 'ch-a-v2' } }));
            assert.notEqual(blocked.status, 200); noClinicalText(blocked.text);
            fs.unlinkSync(blocker); // el volumen vuelve a estar disponible
            await wait(700);
            assert.equal(broken.running(), true, 'el vaciado arrancó en el reintento');
            return { arranque: started.value, sqlSano: served.status, ambosCaidos: blocked.status, reintento: 'activo' };
        } finally { broken.stop(); spoolModule().install(previous); try { fs.rmSync(blocker, { recursive: true, force: true }); } catch { /* ya retirado */ } }
    });
    await step('Q8', 'Hallazgo 5: una escritura parcial se completa antes de publicar; si no puede completarse, la lectura se bloquea sin archivo truncado', async () => {
        const realWrite = fs.writeSync;
        const isSpool = buf => (typeof buf === 'string' || Buffer.isBuffer(buf)) && String(buf).includes('"kind"');
        const partial = (fd, buf, off) => (typeof buf === 'string' ? realWrite.call(fs, fd, buf.slice(0, 12)) : realWrite.call(fs, fd, buf, off || 0, 12));
        const out = {};
        let calls = 0;
        // a) El sistema de archivos acepta sólo 12 bytes en la primera llamada.
        fs.writeSync = function (fd, buf, off) { if (isSpool(buf) && calls++ === 0) return partial(fd, buf, off); return realWrite.apply(fs, arguments); };
        try {
            const before = pendingFiles();
            const r = await withEventWritesFailing('prescription_audit_log', () => call(Prescriptions.getById, 'valeria', { params: { id_prescription: 'rx-a' } }));
            assert.equal(r.status, 200);
            const [file] = readPending(newSince(before));
            assert.ok(file, 'archivo publicado');
            assert.deepEqual([file.event.kind, file.event.actor, file.event.resource], ['prescription_view', 'valeria', 'rx-a'], 'JSON íntegro');
            out.parcial = { llamadas: calls, json: 'íntegro' };
        } finally { fs.writeSync = realWrite; }
        // b) Tras 12 bytes el disco se llena: no hay archivo final ni temporal y la lectura se bloquea.
        calls = 0;
        fs.writeSync = function (fd, buf, off) {
            if (isSpool(buf)) { if (calls++ === 0) return partial(fd, buf, off); throw Object.assign(new Error('no space left'), { code: 'ENOSPC' }); }
            return realWrite.apply(fs, arguments);
        };
        try {
            const before = pendingFiles();
            const r = await withEventWritesFailing('prescription_audit_log', () => call(Prescriptions.getById, 'valeria', { params: { id_prescription: 'rx-a' } }));
            assert.notEqual(r.status, 200); noClinicalText(r.text);
            assert.deepEqual(newSince(before), []);
            assert.deepEqual(fs.readdirSync(pendingDir).filter(f => f.endsWith('.tmp')), [], 'sin temporal truncado');
            out.sinEspacio = r.status;
        } finally { fs.writeSync = realWrite; }
        assert.equal((await spoolModule().shared().drain()).inserted, 1);
        return out;
    });
    await step('Q9', 'Una caída nueva en el mismo segundo en que se resolvió la anterior abre otro ciclo de aviso (reloj inyectado, sin MySQL)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc2-q9-'));
        try {
            let clock = Date.UTC(2026, 10, 25, 12, 0, 0, 200), db;
            const failingDb = { query: async () => { throw Object.assign(new Error('synthetic'), { original: { code: 'ER_SIGNAL_EXCEPTION' } }); } };
            const spool = spoolModule().createAccessAuditSpool({ dir, db: () => db, now: () => clock, alert: async () => ({ ok: true, channel: 'qa' }), env: 'nc2-qa' });
            const read = () => spool.record('prescription_view', { actor: 'valeria', business: A, resource: 'rx-a', status: 'issued', context: 'detail' });
            db = failingDb; await read(); await spool.deliverAlerts();
            db = { query: async () => [] }; clock += 300; await spool.drain(); // se resuelve en el mismo segundo
            clock += 200; db = failingDb; await read(); await spool.deliverAlerts();
            const cycles = spool.outages().map(o => [o.cycle, o.cleared, o.delivered]).sort();
            assert.deepEqual(cycles, [[1, true, true], [2, false, true]], JSON.stringify(cycles));
            return { ciclos: cycles };
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    // 5. Recuperación de la evidencia y ausencia de contenido clínico.
    await step('E1', 'Recuperación por el operador con acceso a la base, filtrada por consultorio; ningún evento contiene texto clínico', async () => {
        const [rows] = await root.query(`
            SELECT 'historia' AS familia, event_type AS operacion, user_id AS actor, business_id AS consultorio, clinical_history_id AS recurso, created_at, metadata_json AS detalle FROM clinical_history_events WHERE business_id = ?
            UNION ALL SELECT 'documento', event_type, created_by, id_business, id_patient_document, created_at, notes FROM patient_document_events WHERE id_business = ?
            UNION ALL SELECT 'receta', action COLLATE utf8mb4_unicode_ci, id_user COLLATE utf8mb4_unicode_ci, id_business COLLATE utf8mb4_unicode_ci,
                id_prescription COLLATE utf8mb4_unicode_ci, created_at, CONVERT(metadata USING utf8mb4) COLLATE utf8mb4_unicode_ci FROM prescription_audit_log WHERE id_business = ?
            ORDER BY created_at`, [A, A, A]);
        assert.ok(rows.length >= 7, "eventos recuperados: " + rows.length);
        noClinicalText(JSON.stringify(rows));
        const [other] = await root.query('SELECT COUNT(*) AS total FROM clinical_history_events WHERE business_id = ?', [B]);
        assert.equal(Number(other[0].total), 0);
        return { eventos: rows.length, familias: [...new Set(rows.map(r => r.familia + ':' + r.operacion))] };
    });

    await root.end();
    await require('../../src/db/Sequelize.connection').close();
    hookServer.close();
    fs.rmSync(SPOOL, { recursive: true, force: true });
    const failed = results.filter(r => r.result === 'FAIL');
    for (const r of results) console.log(`${r.result} ${r.id} ${r.name}${r.error ? ' :: ' + r.error : ''}`);
    console.log(failed.length ? `FAIL: ${failed.length} de ${results.length}` : `PASS: ${results.length} de ${results.length}`);
    if (process.env.NC2_QA_EVIDENCE) fs.writeFileSync(process.env.NC2_QA_EVIDENCE, JSON.stringify({ ranAt: new Date().toISOString(), database: 'MySQL desechable', results }, null, 2));
    if (failed.length) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });

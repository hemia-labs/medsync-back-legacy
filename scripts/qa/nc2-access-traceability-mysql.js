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

async function main() {
    await setup();
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
    await step('H7', 'Falla de escritura del evento al abrir la historia: no entrega contenido y deja una línea con referencia en stderr', async () => {
        const out = await withEventWritesFailing('clinical_history_events', async logged => {
            const r = await call(History.getById, 'valeria', { params: { id: 'ch-a-v2' } });
            assert.notEqual(r.status, 200); noClinicalText(r.text);
            assert.ok(r.payload.data && r.payload.data.reference, 'respuesta con referencia');
            assert.ok(logged.some(line => line.includes('[DATABASE_OPERATION_FAILED]') && line.includes(r.payload.data.reference)));
            return { status: r.status, log: logged.find(line => line.includes('[DATABASE_OPERATION_FAILED]')) };
        });
        return out;
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
    await step('R6', 'Falla de escritura del evento: ni la consulta ni la salida entregan la receta', async () => {
        return withEventWritesFailing('prescription_audit_log', async logged => {
            const view = await call(Prescriptions.getById, 'valeria', { params: { id_prescription: 'rx-a' } });
            const output = await call(Prescriptions.prepareOutput, 'valeria', { body: { id_prescription: 'rx-a', action: 'printed' } });
            for (const r of [view, output]) { assert.notEqual(r.status, 200); noClinicalText(r.text); }
            assert.ok(logged.filter(line => line.includes('[DATABASE_OPERATION_FAILED]')).length >= 2);
            return { consulta: view.status, salida: output.status };
        });
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
    const failed = results.filter(r => r.result === 'FAIL');
    for (const r of results) console.log(`${r.result} ${r.id} ${r.name}${r.error ? ' :: ' + r.error : ''}`);
    console.log(failed.length ? `FAIL: ${failed.length} de ${results.length}` : `PASS: ${results.length} de ${results.length}`);
    if (process.env.NC2_QA_EVIDENCE) fs.writeFileSync(process.env.NC2_QA_EVIDENCE, JSON.stringify({ ranAt: new Date().toISOString(), database: 'MySQL desechable', results }, null, 2));
    if (failed.length) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });

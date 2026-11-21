// NC3: servidor de prueba para verificar la advertencia en la interfaz real (Seguimiento). Solo datos sintéticos.
// Uso: NC3_QA_MYSQL_PORT=<puerto> [NC3_QA_API_PORT=3009] node scripts/qa/nc3-visual-fixture.js
// Levanta las rutas reales de /api/tracing, siembra pacientes con cada caso y expone /qa/state (token y pacientes)
// y /qa/key/off|on para simular la ausencia de la clave del servidor. Elimina su esquema al terminar (Ctrl+C).
'use strict';
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Sequelize } = require('sequelize');
const port = Number(process.env.NC3_QA_MYSQL_PORT);
if (!port) throw Error('Indica NC3_QA_MYSQL_PORT.');
const apiPort = Number(process.env.NC3_QA_API_PORT || 3009);
const schema = 'nc3_visual_' + randomBytes(6).toString('hex');
const opts = { host: '127.0.0.1', port, dialect: 'mysql', logging: false };
const admin = new Sequelize('mysql', 'root', process.env.NC3_QA_MYSQL_PASSWORD || '', opts);
const db = new Sequelize(schema, 'root', process.env.NC3_QA_MYSQL_PASSWORD || '', opts);
const sha = text => createHash('sha256').update(text).digest('hex');
const tables = [
    'doctor_professional_profile (id_login VARCHAR(50),id_business VARCHAR(50),id_doctor_professional_profile VARCHAR(50),professional_name VARCHAR(255),professional_license VARCHAR(100),is_active INT)',
    'person (id_person VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),active INT,code VARCHAR(8),name VARCHAR(80),surname VARCHAR(80))',
    'login (id_login VARCHAR(50),id_business VARCHAR(50),id_rol VARCHAR(50),email VARCHAR(80),locked INT,active INT,name VARCHAR(80))',
    'rol (id_rol VARCHAR(50),code VARCHAR(50),desc_rol VARCHAR(50),active INT)',
    'business (id_business VARCHAR(50),active INT,status VARCHAR(30),billing_revision INT,billing_access_until DATETIME,subscription_status VARCHAR(30),trial_starts_at DATETIME,trial_ends_at DATETIME,current_period_starts_at DATETIME,current_period_ends_at DATETIME,suspended_at DATETIME,cancelled_at DATETIME,status_reason VARCHAR(50))',
    'session (id_session VARCHAR(50),id_login VARCHAR(50),active INT,`last` INT)',
    'cat_permission (id_cat_permission INT,code VARCHAR(50),active INT,is_active INT,value INT,sec INT)',
    'permission_rol (id_rol VARCHAR(50),id_cat_permission INT,active INT)',
    'business_role_permission (id_business VARCHAR(50),id_rol VARCHAR(50),id_cat_permission INT,active INT)',
    'appointment (id_appointment VARCHAR(50),id_person VARCHAR(50),id_business VARCHAR(50),active INT)',
    'treatment_plan (id_treatment_plan VARCHAR(50),id_person VARCHAR(50),id_business VARCHAR(50),active INT,status VARCHAR(50),title VARCHAR(255),started_at DATE,closed_at DATETIME)',
    'patient_treatment (id_patient_treatment VARCHAR(50),id_treatment_plan VARCHAR(50),id_person VARCHAR(50),id_business VARCHAR(50),active INT,status VARCHAR(50),name VARCHAR(255),cost DECIMAL(10,2),source VARCHAR(50),created_by VARCHAR(50),created_at DATETIME,updated_by VARCHAR(50),updated_at DATETIME)',
    'tracing (id_tracing VARCHAR(50) PRIMARY KEY)',
    'patient_code_counter (singleton INT PRIMARY KEY,next_value INT)'
];
async function main() {
    await admin.query('CREATE DATABASE ' + schema + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    for (const spec of tables) await db.query('CREATE TABLE ' + spec);
    for (const file of ['nc5-evolution-draft.sql', 'nc5-evolution-signed.sql', 'nc5-performed-extra.sql', 'nc3-evolution-integrity.sql'])
        for (const statement of fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8').replace(/^--.*$/gm, '').split(';')) if (statement.trim()) await db.query(statement);
    for (const sql of [
        'INSERT INTO patient_code_counter VALUES (1,1)',
        "INSERT INTO doctor_professional_profile VALUES ('doctor','clinic','profile','Dra. Valeria Prueba','CED-TEST-01',1)",
        "INSERT INTO business (id_business,active,status,subscription_status) VALUES ('clinic',1,'active','active')",
        "INSERT INTO login VALUES ('doctor','clinic','r','doctor@example.invalid',0,1,'Valeria')",
        "INSERT INTO rol VALUES ('r','doctor','Doctor',1)", "INSERT INTO session VALUES ('one','doctor',1,1)",
        "INSERT INTO cat_permission VALUES (1,'px.tab.monitoring',1,1,NULL,NULL),(2,'tracing.create',1,1,NULL,NULL),(3,'tracing.correct',1,1,NULL,NULL)",
        "INSERT INTO permission_rol VALUES ('r',1,1),('r',2,1),('r',3,1)"
    ]) await db.query(sql);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nc3-visual-'));
    const keys = 'k1:' + randomBytes(32).toString('hex');
    Object.assign(process.env, { JWT_SECRET: randomBytes(48).toString('hex'), AUTH_COOKIE_MODE: 'legacy', BROWSER_AUTH_TRANSPORT: 'bearer', CSRF_ENABLED: 'false',
        EVOLUTION_INTEGRITY_KEYS: keys, EVOLUTION_INTEGRITY_KEY_ID: 'k1', EVOLUTION_INTEGRITY_ADOPTION_AT: new Date(Date.now() - 3600e3).toISOString(),
        EVOLUTION_INTEGRITY_LOG_DIR: work, EVOLUTION_INTEGRITY_ANCHOR_PATH: path.join(work, 'anchor.jsonl') });
    const dep = require.resolve('../../src/db/Sequelize.connection');
    require.cache[dep] = { id: dep, filename: dep, loaded: true, exports: db };
    const express = require('express'), app = express();
    app.use((req, res, next) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS' });
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });
    app.use(express.json());
    app.use('/api/tracing', require('../../src/routes/mysql/tracing'));
    const token = require('../../src/auth/authenticate').GetAccessToken({ id_business: 'clinic', id_login: 'doctor', id_session: 'one' }).token;
    const base = 'http://127.0.0.1:' + apiPort;
    const call = async (patient, suffix, body) => {
        const r = await fetch(base + '/api/tracing/patient/' + patient + suffix, { method: body ? 'PUT' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
        return r.json();
    };
    const form = (extra = {}) => ({ date: '2026-11-20', origin: '', reason: 'Control de ortodoncia', evolution: 'Paciente sin molestias; brackets estables.', plan: 'Revisión en dos semanas.', none: true, done: [], future: [], performed: '', indication: '', ...extra });
    const notes = [];
    app.get('/qa/state', (req, res) => res.json({ token: 'Bearer ' + token, patients: Object.fromEntries(notes.map(n => [n.key, n])) }));
    app.get('/qa/key/:mode', (req, res) => {
        if (req.params.mode === 'off') delete process.env.EVOLUTION_INTEGRITY_KEYS; else process.env.EVOLUTION_INTEGRITY_KEYS = keys;
        res.json({ ok: true, key: req.params.mode });
    });
    app.use((err, req, res, next) => { console.error(err.message); res.sendStatus(500); });
    const server = await new Promise(resolve => { const s = app.listen(apiPort, '127.0.0.1', () => resolve(s)); });
    let n = 0;
    const seed = async (key, label, versions, after) => {
        const patient = 'v' + (++n);
        await db.query("INSERT INTO person (id_person,id_business,active,code,name,surname) VALUES (:p,'clinic',1,:c,'Paciente',:s)", { replacements: { p: patient, c: String(200000 + n), s: label } });
        const id = randomUUID();
        if (versions) {
            await call(patient, '/evolution-drafts/' + id, { revision: 0, form: form() });
            await call(patient, '/evolution-notes/' + id + '/sign', { requestId: randomUUID(), revision: 1 });
            for (let v = 2; v <= versions; v++) await call(patient, '/evolution-notes/' + id + '/rectify', { requestId: randomUUID(), revision: v - 1, reason: 'Se precisó el plan', form: form({ plan: 'Revisión en tres semanas.' }) });
        }
        if (after) await after(patient, id);
        notes.push({ key, label, patient, note: id });
    };
    const legacy = (p, id) => db.query("INSERT INTO evolution_note_signed_version (id_business,id_person,note_id,version,draft_revision,request_id,request_hash,author_id,signer_profile,signer_name,signer_license,signed_at,payload) VALUES ('clinic',:p,:id,1,1,:r,:h,'doctor','profile','Dra. Valeria Prueba','CED-TEST-01','2020-03-01 10:00:00.000000',:pl)",
        { replacements: { p, id, r: randomUUID(), h: sha(id), pl: JSON.stringify(form({ plan: 'Nota anterior al control.' })) } });
    await seed('integra', 'Íntegra', 2);
    await seed('historica', 'Histórica', 0, legacy);
    await seed('contenido', 'Plan alterado', 2, (p, id) => db.query("UPDATE evolution_note_signed_version SET payload=JSON_SET(payload,'$.plan','Plan alterado fuera de MedSync') WHERE note_id=:id AND version=1", { replacements: { id } }));
    await seed('v1ausente', 'Original ausente', 2, (p, id) => db.query('DELETE FROM evolution_note_signed_version WHERE note_id=:id AND version=1', { replacements: { id } }));
    await seed('ultima', 'Última ausente', 2, (p, id) => db.query('DELETE FROM evolution_note_signed_version WHERE note_id=:id AND version=2', { replacements: { id } }));
    await seed('todas', 'Todas ausentes', 2, (p, id) => db.query('DELETE FROM evolution_note_signed_version WHERE note_id=:id', { replacements: { id } }));
    console.log('FIXTURE_READY ' + base + ' ' + schema);
    const stop = async () => { await new Promise(r => server.close(r)); await db.close(); await admin.query('DROP DATABASE ' + schema); await admin.close(); fs.rmSync(work, { recursive: true, force: true }); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch(error => { console.error(error.stack || error.message); process.exit(1); });

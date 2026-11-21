// NC3: ensayo de integridad de notas firmadas contra un MySQL aislado (NC3_QA_MYSQL_PORT) con datos sintéticos.
// Crea un esquema con nombre aleatorio y solo lo elimina a él. Dos capas separadas:
//  - detección automática de MedSync: lo que devuelve la API real (Express + autenticación + MySQL);
//  - cotejo externo: este script lee las filas directo de MySQL y calcula sus propias huellas, sin usar el servicio de MedSync.
// Con NC3_QA_EVIDENCE_DIR escribe results.json (esperado, devuelto, lo que ve el profesional y cotejo externo por caso).
'use strict';
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Sequelize } = require('sequelize');
const port = Number(process.env.NC3_QA_MYSQL_PORT);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw Error('Indica el puerto de MySQL aislado en NC3_QA_MYSQL_PORT.');
const schema = 'nc3_integrity_qa_' + randomBytes(8).toString('hex');
const opts = { host: '127.0.0.1', port, dialect: 'mysql', logging: false };
const password = process.env.NC3_QA_MYSQL_PASSWORD || '';
const admin = new Sequelize('mysql', 'root', password, opts);
const db = new Sequelize(schema, 'root', password, opts);
const definitions = [
    'doctor_professional_profile (id_login VARCHAR(50),id_business VARCHAR(50),id_doctor_professional_profile VARCHAR(50),professional_name VARCHAR(255),professional_license VARCHAR(100),is_active INT)',
    'person (id_person VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),active INT)',
    'login (id_login VARCHAR(50),id_business VARCHAR(50),id_rol VARCHAR(50),email VARCHAR(80),locked INT,active INT)',
    'rol (id_rol VARCHAR(50),code VARCHAR(50),desc_rol VARCHAR(50),active INT)',
    'business (id_business VARCHAR(50),active INT,status VARCHAR(30),billing_revision INT,billing_access_until DATETIME,subscription_status VARCHAR(30),trial_starts_at DATETIME,trial_ends_at DATETIME,current_period_starts_at DATETIME,current_period_ends_at DATETIME,suspended_at DATETIME,cancelled_at DATETIME,status_reason VARCHAR(50))',
    'session (id_session VARCHAR(50),id_login VARCHAR(50),active INT,`last` INT)',
    'cat_permission (id_cat_permission INT,code VARCHAR(50),active INT,is_active INT)',
    'permission_rol (id_rol VARCHAR(50),id_cat_permission INT,active INT)',
    'business_role_permission (id_business VARCHAR(50),id_rol VARCHAR(50),id_cat_permission INT,active INT)',
    'appointment (id_appointment VARCHAR(50),id_person VARCHAR(50),id_business VARCHAR(50),active INT)',
    'treatment_plan (id_treatment_plan VARCHAR(50),id_person VARCHAR(50),id_business VARCHAR(50),active INT,status VARCHAR(50))',
    'patient_treatment (id_patient_treatment VARCHAR(50),id_treatment_plan VARCHAR(50),id_person VARCHAR(50),id_business VARCHAR(50),active INT,status VARCHAR(50),name VARCHAR(255),cost DECIMAL(10,2),source VARCHAR(50),created_by VARCHAR(50),created_at DATETIME)'
];
const sha = text => createHash('sha256').update(text).digest('hex');
const STATE_TEXT = {
    verified: 'Nota firmada con sello «Integridad verificada».',
    historical: 'Etiqueta «Anterior al control de integridad»; se lee normal, sin afirmar que esté íntegra.',
    unavailable: 'Aviso ámbar «No se pudo comprobar la integridad» con botón Reintentar; la nota no se marca como verificada.',
    discrepancy: 'Aviso rojo «Revisión requerida»: la versión no se presenta como nota firmada válida; acción: avisar al administrador para restaurar.'
};
const results = [];

async function run() {
    await admin.query('CREATE DATABASE ' + schema + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    let server;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nc3-qa-'));
    try {
        for (const spec of definitions) await db.query('CREATE TABLE ' + spec);
        for (const file of ['nc5-evolution-draft.sql', 'nc5-evolution-signed.sql', 'nc5-performed-extra.sql', 'nc3-evolution-integrity.sql'])
            for (const statement of fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8').replace(/^--.*$/gm, '').split(';')) if (statement.trim()) await db.query(statement);
        await db.query('CREATE TABLE patient_code_counter(singleton INT PRIMARY KEY,next_value INT)');
        await db.query('INSERT INTO patient_code_counter VALUES (1,1)');
        await db.query('ALTER TABLE person ADD code VARCHAR(8), ADD UNIQUE INDEX uq_code(code), ADD name VARCHAR(80), ADD surname VARCHAR(80)');
        await db.query('ALTER TABLE login ADD name VARCHAR(80)');
        await db.query('ALTER TABLE cat_permission ADD value INT, ADD sec INT');
        await db.query('ALTER TABLE treatment_plan ADD title VARCHAR(255),ADD started_at DATE,ADD closed_at DATETIME');
        await db.query('ALTER TABLE patient_treatment ADD updated_by VARCHAR(50),ADD updated_at DATETIME');
        await db.query('CREATE TABLE tracing (id_tracing VARCHAR(50) PRIMARY KEY)');
        for (const sql of [
            "INSERT INTO doctor_professional_profile VALUES ('doctor','clinic','profile','Doctora de prueba','TEST01',1)",
            "INSERT INTO business (id_business,active,status,subscription_status) VALUES ('clinic',1,'active','active'),('other',1,'active','active')",
            "INSERT INTO login (id_login,id_business,id_rol,email,locked,active,name) VALUES ('doctor','clinic','r','doctor@example.invalid',0,1,'doctor'),('remote','other','r','remote@example.invalid',0,1,'remote')",
            "INSERT INTO rol VALUES ('r','doctor','Doctor',1)",
            "INSERT INTO session VALUES ('one','doctor',1,1),('two','doctor',1,1),('five','remote',1,1)",
            "INSERT INTO cat_permission (id_cat_permission,code,active,is_active) VALUES (1,'px.tab.monitoring',1,1),(2,'tracing.create',1,1),(3,'tracing.correct',1,1)",
            "INSERT INTO permission_rol VALUES ('r',1,1),('r',2,1),('r',3,1)",
            "INSERT INTO person (id_person,id_business,active,name,surname,code) VALUES ('outside','other',1,'Ajeno','Prueba','900001')"
        ]) await db.query(sql);

        const key = randomBytes(32).toString('hex');
        const adoption = new Date(Date.now() - 3600e3).toISOString();
        process.env.JWT_SECRET = randomBytes(48).toString('hex');
        Object.assign(process.env, { AUTH_COOKIE_MODE: 'legacy', BROWSER_AUTH_TRANSPORT: 'bearer', CSRF_ENABLED: 'false',
            EVOLUTION_INTEGRITY_KEYS: 'k1:' + key, EVOLUTION_INTEGRITY_KEY_ID: 'k1', EVOLUTION_INTEGRITY_ADOPTION_AT: adoption,
            EVOLUTION_INTEGRITY_LOG_DIR: work, EVOLUTION_INTEGRITY_ANCHOR_PATH: path.join(work, 'anchor.jsonl') });
        const dep = require.resolve('../../src/db/Sequelize.connection');
        require.cache[dep] = { id: dep, filename: dep, loaded: true, exports: db };
        const express = require('express'), app = express();
        app.use(express.json());
        app.use('/api/tracing', require('../../src/routes/mysql/tracing'));
        app.use((err, req, res, next) => { console.error(err.message); res.sendStatus(500); });
        server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const issue = (business, login, session) => require('../../src/auth/authenticate').GetAccessToken({ id_business: business, id_login: login, id_session: session }).token;
        const A = issue('clinic', 'doctor', 'one'), B = issue('clinic', 'doctor', 'two'), R = issue('other', 'remote', 'five');
        const base = 'http://127.0.0.1:' + server.address().port + '/api/tracing/patient/';
        const call = async (token, patient, suffix, body) => {
            const r = await fetch(base + patient + suffix, { method: body ? 'PUT' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
            return { status: r.status, ...(await r.json()) };
        };
        let counter = 0;
        const newPatient = async () => {
            const id = 'px' + (++counter);
            await db.query("INSERT INTO person (id_person,id_business,active,name,surname,code) VALUES (:id,'clinic',1,'Paciente','Sintético',:code)", { replacements: { id, code: String(100000 + counter) } });
            return id;
        };
        const baseForm = { date: '2026-11-20', origin: '', reason: 'Control sintético', evolution: 'Evolución sintética', plan: 'Plan original: revisión en dos semanas', none: true, done: [], future: [], performed: '', indication: '' };
        const signNote = async (patient, token = A, requestId = randomUUID()) => {
            const id = randomUUID();
            assert.equal((await call(token, patient, '/evolution-drafts/' + id, { revision: 0, form: baseForm })).status, 200);
            const result = await call(token, patient, '/evolution-notes/' + id + '/sign', { requestId, revision: 1 });
            assert.equal(result.status, 200, JSON.stringify(result));
            return { id, result };
        };
        const rectify = (patient, id, revision, plan, token = A, requestId = randomUUID()) =>
            call(token, patient, '/evolution-notes/' + id + '/rectify', { requestId, revision, reason: 'Corrección sintética', form: { ...baseForm, plan } });
        // Cotejo externo: huellas calculadas aquí, sin código de MedSync.
        const external = async (patient, id) => {
            const rows = (await db.query('SELECT * FROM evolution_note_signed_version WHERE id_person=:patient AND note_id=:id ORDER BY version', { replacements: { patient, id } }))[0];
            return Object.fromEntries(rows.map(r => [r.version, sha(JSON.stringify([r.version, r.author_id, r.signer_name, r.signer_license, String(r.signed_at && r.signed_at.getTime()), r.correction_reason, r.payload]))]));
        };
        const compare = (before, after) => {
            const out = {};
            for (const v of Object.keys(before)) out['v' + v] = !(v in after) ? 'AUSENTE' : before[v] === after[v] ? 'igual' : 'DISTINTA';
            for (const v of Object.keys(after)) if (!(v in before)) out['v' + v] = 'NUEVA';
            return out;
        };
        const states = async (patient, id) => {
            const versions = await call(A, patient, '/evolution-notes/' + id + '/versions');
            const list = await call(A, patient, '/evolution-notes');
            return {
                status: versions.status, message: versions.message, summary: versions.data.integrity,
                versions: versions.data.items.map(i => ({ version: i.version, state: i.integrity.state, code: i.integrity.code, content: !!i.form })),
                list: list.data.items.filter(i => i.id === id).map(i => ({ state: i.integrity.state, code: i.integrity.code, content: !!i.form }))
            };
        };
        const record = (id, esperado, actual, state, externo) => {
            results.push({ caso: id, esperado, devolvio: actual, profesional: STATE_TEXT[state] || state, cotejoExterno: externo });
            console.log('PASS ' + id);
        };
        const stateIs = (got, version, state, code, content) => {
            const found = got.versions.find(v => v.version === version);
            assert.ok(found, 'versión ' + version + ' ausente en la respuesta: ' + JSON.stringify(got.versions));
            assert.equal(found.state, state, JSON.stringify(got));
            if (code !== undefined) assert.equal(found.code, code);
            assert.equal(found.content, content);
        };

        // 1. Nota íntegra
        {
            const p = await newPatient(), { id, result } = await signNote(p);
            assert.equal(result.data.integrity.state, 'verified');
            const before = await external(p, id), got = await states(p, id);
            stateIs(got, 1, 'verified', null, true);
            assert.deepEqual(got.list, [{ state: 'verified', code: null, content: true }]);
            assert.equal(got.summary.state, 'verified');
            assert.equal((await db.query('SELECT COUNT(*) c FROM evolution_integrity_ledger WHERE id_person=:p', { replacements: { p } }))[0][0].c, 1);
            record('C01 nota íntegra', 'v1 verified y legible', got, 'verified', compare(before, await external(p, id)));
        }
        // 2. Rectificación legítima
        let legit;
        {
            const p = await newPatient(), { id } = await signNote(p);
            const before = await external(p, id);
            const fixed = await rectify(p, id, 1, 'Plan corregido: revisión en tres semanas');
            assert.equal(fixed.status, 200, JSON.stringify(fixed));
            assert.equal(fixed.data.version, 2);
            assert.equal(fixed.data.integrity.state, 'verified');
            const got = await states(p, id);
            stateIs(got, 1, 'verified', null, true); stateIs(got, 2, 'verified', null, true);
            assert.deepEqual(got.list, [{ state: 'verified', code: null, content: true }]);
            const after = await external(p, id);
            assert.equal(after[1], before[1]);
            record('C02 rectificación legítima', 'v1 intacta y v2 verified, ambas legibles', got, 'verified', compare(before, after));
            legit = { p, id };
        }
        // 3-6. Cambio de contenido, autor, firmante y fecha de v1
        const tamper = [
            ['C03 cambio de contenido de v1', "UPDATE evolution_note_signed_version SET payload=JSON_SET(payload,'$.plan','Plan alterado') WHERE note_id=:id AND version=1"],
            ['C04 cambio de autor de v1', "UPDATE evolution_note_signed_version SET author_id='otro' WHERE note_id=:id AND version=1"],
            ['X1 cambio de autor de la versión vigente v2', "UPDATE evolution_note_signed_version SET author_id='otro' WHERE note_id=:id AND version=2"],
            ['C05 cambio de firmante de v1', "UPDATE evolution_note_signed_version SET signer_name='Otra persona' WHERE note_id=:id AND version=1"],
            ['C06 cambio de fecha de firma de v1', "UPDATE evolution_note_signed_version SET signed_at=DATE_ADD(signed_at,INTERVAL 1 SECOND) WHERE note_id=:id AND version=1"],
            ['C07 cambio del motivo de rectificación de v2', "UPDATE evolution_note_signed_version SET correction_reason='Motivo cambiado' WHERE note_id=:id AND version=2"]
        ];
        for (const [name, sql] of tamper) {
            const signRequest = randomUUID(), correctionRequest = randomUUID();
            const p = await newPatient(), { id } = await signNote(p, A, signRequest);
            assert.equal((await rectify(p, id, 1, 'Plan corregido', A, correctionRequest)).status, 200);
            const before = await external(p, id);
            await db.query(sql, { replacements: { id } });
            const got = await states(p, id), hit = name.includes('v2') ? 2 : 1, other = hit === 1 ? 2 : 1;
            stateIs(got, hit, 'discrepancy', 'CONTENT_MISMATCH', false);
            stateIs(got, other, 'verified', null, true);
            assert.deepEqual(got.list, [{ state: 'discrepancy', code: 'CONTENT_MISMATCH', content: false }]);
            assert.equal(got.summary.state, 'discrepancy');
            const blocked = await rectify(p, id, 2, 'Otra corrección');
            assert.equal(blocked.status, 409); assert.equal(blocked.data.code, 'CONTENT_MISMATCH');
            const retriedSign = await call(A, p, '/evolution-notes/' + id + '/sign', { requestId: signRequest, revision: 1 });
            const retriedCorrection = await rectify(p, id, 1, 'Plan corregido', A, correctionRequest);
            for (const result of [retriedSign, retriedCorrection]) {
                assert.equal(result.status, 409);
                assert.deepEqual(result.data, { code: 'CONTENT_MISMATCH' });
            }
            assert.equal(Object.keys(await external(p, id)).length, 2);
            record(name, 'discrepancia confirmada; contenido retirado de la versión afectada; la otra versión sigue legible; rectificar se rechaza con 409', got, 'discrepancy', compare(before, await external(p, id)));
        }
        // 7-10. Versiones ausentes
        {
            const make = async count => {
                const p = await newPatient(), { id } = await signNote(p);
                for (let v = 1; v < count; v++) assert.equal((await rectify(p, id, v, 'Plan versión ' + (v + 1))).status, 200);
                return { p, id, before: await external(p, id) };
            };
            const drop = (id, versions) => db.query('DELETE FROM evolution_note_signed_version WHERE note_id=:id AND version IN (' + versions.join(',') + ')', { replacements: { id } });
            let c = await make(2); await drop(c.id, [1]);
            let got = await states(c.p, c.id);
            stateIs(got, 1, 'discrepancy', 'VERSION_MISSING', false); stateIs(got, 2, 'verified', null, true);
            assert.equal(got.list[0].state, 'discrepancy');
            record('C08 ausencia de v1', 'v1 VERSION_MISSING, v2 legible', got, 'discrepancy', compare(c.before, await external(c.p, c.id)));
            c = await make(3); await drop(c.id, [2]);
            got = await states(c.p, c.id);
            stateIs(got, 2, 'discrepancy', 'VERSION_MISSING', false); stateIs(got, 1, 'verified', null, true); stateIs(got, 3, 'verified', null, true);
            record('C09 ausencia de una versión intermedia (v2 de 3)', 'v2 VERSION_MISSING; v1 y v3 verificadas', got, 'discrepancy', compare(c.before, await external(c.p, c.id)));
            c = await make(2); await drop(c.id, [2]);
            got = await states(c.p, c.id);
            stateIs(got, 2, 'discrepancy', 'VERSION_MISSING', false); stateIs(got, 1, 'verified', null, true);
            assert.deepEqual(got.list, [{ state: 'discrepancy', code: 'VERSION_MISSING', content: false }], 'la lista no puede presentar v1 como nota vigente');
            record('C10 ausencia de la última versión (v2 de 2)', 'v2 VERSION_MISSING; en la lista la nota no se presenta como vigente', got, 'discrepancy', compare(c.before, await external(c.p, c.id)));
            c = await make(2); await drop(c.id, [1, 2]);
            got = await states(c.p, c.id);
            assert.ok(got.versions.every(v => v.state === 'discrepancy' && !v.content) && got.versions.length === 2);
            assert.deepEqual(got.list, [{ state: 'discrepancy', code: 'VERSION_MISSING', content: false }]);
            const resign = await call(A, c.p, '/evolution-notes/' + c.id + '/sign', { requestId: randomUUID(), revision: 1 });
            assert.equal(resign.status, 409); assert.equal(resign.data.code, 'VERSION_MISSING');
            assert.equal((await db.query('SELECT COUNT(*) c FROM evolution_note_signed_version WHERE note_id=:id', { replacements: { id: c.id } }))[0][0].c, 0);
            record('C11 ausencia de todas las versiones de una nota conocida', 'la lista conserva la nota como discrepancia; ninguna versión legible; volver a firmar el borrador se rechaza con 409 sin reescribir la nota', got, 'discrepancy', compare(c.before, await external(c.p, c.id)));
        }
        // 12-14. Referencia no disponible
        {
            const p = await newPatient(), { id } = await signNote(p);
            const before = await external(p, id);
            await db.query('RENAME TABLE evolution_integrity_ledger TO qa_held_ledger');
            let got = await states(p, id);
            stateIs(got, 1, 'unavailable', 'REFERENCE_UNAVAILABLE', true);
            const refused = await call(A, p, '/evolution-notes/' + randomUUID() + '/sign', { requestId: randomUUID(), revision: 1 });
            record('C12 referencia no disponible (tabla ausente), lectura', 'estado unavailable, contenido visible y sin sello de verificado; firmar devuelve 503 (no 500)', got, 'unavailable', compare(before, await external(p, id)));
            await db.query('RENAME TABLE qa_held_ledger TO evolution_integrity_ledger');
            got = await states(p, id);
            stateIs(got, 1, 'verified', null, true);
            assert.equal(refused.status, 503); assert.equal(refused.data.code, 'SEAL_UNAVAILABLE');
            const saved = process.env.EVOLUTION_INTEGRITY_KEYS;
            delete process.env.EVOLUTION_INTEGRITY_KEYS;
            got = await states(p, id);
            stateIs(got, 1, 'unavailable', 'KEY_UNAVAILABLE', true);
            const draft = randomUUID(), req = randomUUID();
            await call(A, p, '/evolution-drafts/' + draft, { revision: 0, form: baseForm });
            const noKey = await call(A, p, '/evolution-notes/' + draft + '/sign', { requestId: req, revision: 1 });
            assert.equal(noKey.status, 503); assert.equal(noKey.data.code, 'SEAL_UNAVAILABLE');
            assert.equal((await db.query('SELECT COUNT(*) c FROM evolution_note_signed_version WHERE note_id=:d', { replacements: { d: draft } }))[0][0].c, 0);
            process.env.EVOLUTION_INTEGRITY_KEYS = saved;
            const retried = await call(A, p, '/evolution-notes/' + draft + '/sign', { requestId: req, revision: 1 });
            assert.equal(retried.status, 200); assert.equal(retried.data.version, 1);
            record('C13 clave del servidor ausente: lectura y firma', 'lectura unavailable/KEY_UNAVAILABLE; firma 503 sin escribir nada; al volver la clave el mismo reintento firma v1', { read: got, sign: { status: noKey.status, code: noKey.data.code, message: noKey.message } }, 'unavailable', { filasDeFirmaTrasElFallo: 0 });
        }
        // 14. Histórico sin referencia, rectificación del histórico y alteración posterior
        {
            const p = await newPatient(), id = randomUUID(), form = { ...baseForm, plan: 'Plan heredado' };
            const insertLegacy = (note, version, at) => db.query("INSERT INTO evolution_note_signed_version (id_business,id_person,note_id,version,draft_revision,request_id,request_hash,author_id,signer_profile,signer_name,signer_license,signed_at,payload,correction_reason) VALUES ('clinic',:p,:note,:version,1,:req,:hash,'doctor','profile','Doctora de prueba','TEST01',:at,:payload,NULL)",
                { replacements: { p, note, version, req: randomUUID(), hash: sha(note + version), at, payload: JSON.stringify(form) } });
            await insertLegacy(id, 1, '2020-01-01 10:00:00.000000');
            const before = await external(p, id);
            let got = await states(p, id);
            stateIs(got, 1, 'historical', null, true);
            assert.equal(got.summary.state, 'historical');
            record('C14 nota histórica sin referencia previa', 'historical, legible, sin afirmar integridad', got, 'historical', compare(before, await external(p, id)));
            const fixed = await rectify(p, id, 1, 'Plan heredado corregido');
            assert.equal(fixed.status, 200, JSON.stringify(fixed));
            got = await states(p, id);
            stateIs(got, 1, 'historical', null, true); stateIs(got, 2, 'verified', null, true);
            record('C15 rectificación de una nota histórica', 'v1 sigue historical; v2 verified con vínculo a la huella de v1', got, 'historical', compare(before, await external(p, id)));
            await db.query("UPDATE evolution_note_signed_version SET payload=JSON_SET(payload,'$.plan','Alterado tras la rectificación') WHERE note_id=:id AND version=1", { replacements: { id } });
            got = await states(p, id);
            stateIs(got, 1, 'discrepancy', 'CONTENT_MISMATCH', false); stateIs(got, 2, 'verified', null, true);
            record('C16 alteración posterior de una v1 histórica ya rectificada', 'v1 discrepancia por el vínculo de v2; sin atribuir integridad retrospectiva', got, 'discrepancy', compare(before, await external(p, id)));
            await db.query('DELETE FROM evolution_note_signed_version WHERE note_id=:id AND version=1', { replacements: { id } });
            got = await states(p, id);
            stateIs(got, 1, 'discrepancy', 'VERSION_MISSING', false);
            record('C17 borrado de una v1 histórica ya rectificada', 'VERSION_MISSING por el vínculo de v2', got, 'discrepancy', {});
            const p2 = await newPatient(), forged = randomUUID();
            await insertLegacy.call(null, forged, 1, new Date().toISOString().replace('T', ' ').replace('Z', '000')).catch(() => {});
            await db.query("INSERT INTO evolution_note_signed_version (id_business,id_person,note_id,version,draft_revision,request_id,request_hash,author_id,signer_profile,signer_name,signer_license,signed_at,payload) VALUES ('clinic',:p,:note,1,1,:req,:hash,'doctor','profile','Doctora de prueba','TEST01',UTC_TIMESTAMP(6),:payload)",
                { replacements: { p: p2, note: forged, req: randomUUID(), hash: sha(forged), payload: JSON.stringify(form) } });
            got = await states(p2, forged);
            stateIs(got, 1, 'discrepancy', 'UNREFERENCED_VERSION', false);
            record('C18 fila inyectada tras la adopción sin asiento', 'UNREFERENCED_VERSION, no se presenta como histórica', got, 'discrepancy', {});
        }
        // 19-22. Manipulación de la referencia
        {
            const make = async () => { const p = await newPatient(), { id } = await signNote(p); assert.equal((await rectify(p, id, 1, 'Plan v2')).status, 200); return { p, id }; };
            let c = await make(), got;
            // forjar un asiento sin la clave: cambia el contenido y recalcula la huella en el asiento
            await db.query("UPDATE evolution_note_signed_version SET payload=JSON_SET(payload,'$.plan','Falso') WHERE note_id=:id AND version=1", { replacements: { id: c.id } });
            await db.query("UPDATE evolution_integrity_ledger SET digest=:d WHERE note_id=:id AND version=1", { replacements: { id: c.id, d: sha('falsificado') } });
            got = await states(c.p, c.id);
            stateIs(got, 1, 'discrepancy', 'LEDGER_ENTRY_INVALID', false);
            assert.ok(got.summary.faults.includes('LEDGER_ENTRY_INVALID'));
            record('C19 alteración de la nota y del asiento sin la clave', 'el asiento falsificado no valida (MAC) y se informa discrepancia', got, 'discrepancy', {});
            c = await make();
            await db.query('DELETE FROM evolution_integrity_ledger WHERE note_id=:id AND version=1', { replacements: { id: c.id } });
            got = await states(c.p, c.id);
            assert.ok(got.summary.faults.includes('LEDGER_GAP'), JSON.stringify(got.summary));
            record('C20 borrado de un asiento de la cadena', 'LEDGER_GAP a nivel de paciente', got, 'discrepancy', {});
            c = await make();
            await db.query('DELETE FROM evolution_integrity_ledger WHERE note_id=:id AND version=2', { replacements: { id: c.id } });
            await db.query('DELETE FROM evolution_note_signed_version WHERE note_id=:id AND version=2', { replacements: { id: c.id } });
            got = await states(c.p, c.id);
            assert.ok(got.summary.faults.includes('LEDGER_TRUNCATED'), JSON.stringify(got.summary));
            assert.equal(got.summary.state, 'discrepancy');
            record('C21 borrado simultáneo de la última versión y de su asiento', 'la cabecera autenticada delata el truncamiento (LEDGER_TRUNCATED)', got, 'discrepancy', {});
            // Límite declarado: volver nota, asiento y cabecera a una copia anterior válida no lo detecta el servidor; el ancla externa sí.
            const q = (sql, r) => db.query(sql, { replacements: r });
            const p3 = await newPatient(), first = await signNote(p3);
            const oldHead = (await q('SELECT * FROM evolution_integrity_head WHERE id_person=:p', { p: p3 }))[0][0];
            assert.equal((await rectify(p3, first.id, 1, 'Plan v2 que se revertirá')).status, 200);
            await q('DELETE FROM evolution_note_signed_version WHERE note_id=:id AND version=2', { id: first.id });
            await q('DELETE FROM evolution_integrity_ledger WHERE note_id=:id AND version=2', { id: first.id });
            await q('UPDATE evolution_integrity_head SET last_seq=:s,last_mac=:m,key_id=:k,mac=:c WHERE id_person=:p', { s: oldHead.last_seq, m: oldHead.last_mac, k: oldHead.key_id, c: oldHead.mac, p: p3 });
            got = await states(p3, first.id);
            stateIs(got, 1, 'verified', null, true);
            assert.equal(got.summary.state, 'verified');
            const anchored = fs.readFileSync(path.join(work, 'anchor.jsonl'), 'utf8').trim().split(String.fromCharCode(10)).map(JSON.parse).filter(a => a.patient === p3);
            const head = (await q('SELECT last_seq FROM evolution_integrity_head WHERE id_person=:p', { p: p3 }))[0][0];
            const external = Math.max(...anchored.map(a => a.seq)) > Number(head.last_seq);
            assert.equal(external, true);
            record('C22 reversión completa a una copia válida anterior (límite conocido)', 'MedSync NO lo detecta sin ancla externa (queda verified); el cotejo del ancla sí: seq=2 registrado frente a cabecera seq=1', { medsync: got.summary.state, ancla: anchored.map(a => a.seq), cabecera: Number(head.last_seq) }, 'verified', { anclaDetecta: external });
        }
        // 23. Reintentos, concurrencia y fallo parcial
        {
            const p = await newPatient(), id = randomUUID(), req = randomUUID();
            await call(A, p, '/evolution-drafts/' + id, { revision: 0, form: baseForm });
            const runs = await Promise.all([A, B].map(t => call(t, p, '/evolution-notes/' + id + '/sign', { requestId: req, revision: 1 })));
            for (const r of runs) assert.equal(r.data.version, 1, JSON.stringify(r));
            assert.equal((await db.query('SELECT COUNT(*) c FROM evolution_integrity_ledger WHERE note_id=:id', { replacements: { id } }))[0][0].c, 1);
            const replay = await call(A, p, '/evolution-notes/' + id + '/sign', { requestId: req, revision: 1 });
            assert.equal(replay.data.integrity.state, 'verified');
            record('C23 reintento y firma concurrente con la misma petición', 'una sola versión y un solo asiento; el reintento devuelve verified', { respuestas: runs.map(r => r.status), reintento: replay.data.integrity }, 'verified', {});
            const race = await Promise.all([A, B].map((t, i) => rectify(p, id, 1, 'Plan concurrente ' + i, t)));
            assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
            assert.equal((await db.query('SELECT COUNT(*) c FROM evolution_integrity_ledger WHERE note_id=:id', { replacements: { id } }))[0][0].c, 2);
            record('C24 dos rectificaciones concurrentes sobre la misma versión', 'una versión nueva y un 409', { respuestas: race.map(r => r.status) }, 'verified', {});
            // fallo parcial: el asiento falla después de insertar la versión
            const p2 = await newPatient(), d = randomUUID(), rq = randomUUID();
            await call(A, p2, '/evolution-drafts/' + d, { revision: 0, form: baseForm });
            await db.query("CREATE TRIGGER qa_block_ledger BEFORE INSERT ON evolution_integrity_ledger FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='qa'");
            const failed = await call(A, p2, '/evolution-notes/' + d + '/sign', { requestId: rq, revision: 1 });
            const left = (await db.query('SELECT COUNT(*) c FROM evolution_note_signed_version WHERE note_id=:d', { replacements: { d } }))[0][0].c;
            await db.query('DROP TRIGGER qa_block_ledger');
            assert.equal(failed.status, 503); assert.equal(failed.data.code, 'SEAL_FAILED'); assert.equal(left, 0);
            const again = await call(A, p2, '/evolution-notes/' + d + '/sign', { requestId: rq, revision: 1 });
            assert.equal(again.status, 200); assert.equal(again.data.version, 1);
            assert.equal((await db.query('SELECT COUNT(*) c FROM evolution_note_signed_version WHERE note_id=:d', { replacements: { d } }))[0][0].c, 1);
            record('C25 fallo parcial al escribir el asiento', '503, ninguna fila de versión queda; el mismo reintento firma v1 una sola vez', { primero: { status: failed.status, code: failed.data.code }, reintento: again.status, filasTrasElFallo: left }, 'verified', {});
        }
        // 26. Aislamiento entre consultorios
        {
            const p = await newPatient(), { id } = await signNote(p);
            await db.query("UPDATE evolution_note_signed_version SET payload=JSON_SET(payload,'$.plan','x') WHERE note_id=:id AND version=1", { replacements: { id } });
            const foreign = await call(R, p, '/evolution-notes/' + id + '/versions');
            const unknown = await call(R, p, '/evolution-notes/' + randomUUID() + '/versions');
            assert.equal(foreign.status, 404); assert.equal(unknown.status, 404);
            assert.deepEqual({ ...foreign, data: null }, { ...unknown, data: null });
            assert.equal((await call(R, p, '/evolution-notes')).status, 404);
            const own = await call(R, 'outside', '/evolution-notes/' + id + '/versions'), none = await call(R, 'outside', '/evolution-notes/' + randomUUID() + '/versions');
            assert.deepEqual(own, none);
            assert.equal(own.data.items.length, 0);
            const text = JSON.stringify([foreign, own]);
            assert.ok(!text.includes(id) && !/discrepancy|CONTENT_MISMATCH/.test(text));
            const sign = await call(R, p, '/evolution-notes/' + id + '/rectify', { requestId: randomUUID(), revision: 1, reason: 'x', form: baseForm });
            assert.ok([403, 404].includes(sign.status));
            record('C26 acceso desde otro consultorio', '404 idéntico al de una nota inexistente; sin ids ni estados ajenos; la rectificación no procede', { pacienteAjeno: foreign.status, notaInexistente: unknown.status, propioPacienteConNotaAjena: own.status }, 'verified', {});
        }
        // Evidencia operativa sin texto clínico
        const events = fs.readFileSync(path.join(work, 'evolution-integrity-events.jsonl'), 'utf8');
        assert.ok(events.includes('CONTENT_MISMATCH') && events.includes('VERSION_MISSING'));
        assert.ok(!/Plan alterado|Plan original|Evolución sintética|Control sintético/.test(events), 'el evento no debe copiar texto clínico');
        const anchors = fs.readFileSync(path.join(work, 'anchor.jsonl'), 'utf8');
        assert.ok(!/Plan original|Evolución sintética/.test(anchors));
        console.log('PASS evidencia operativa: eventos y ancla sin texto clínico (' + events.trim().split('\n').length + ' eventos).');
        if (process.env.NC3_QA_EVIDENCE_DIR) {
            fs.mkdirSync(process.env.NC3_QA_EVIDENCE_DIR, { recursive: true });
            fs.writeFileSync(path.join(process.env.NC3_QA_EVIDENCE_DIR, 'results.json'), JSON.stringify({ fecha: new Date().toISOString(), entorno: 'MySQL aislado con datos sintéticos', casos: results }, null, 2));
        }
        console.log('PASS NC3: ' + results.length + ' casos de integridad.');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        await db.close(); await admin.query('DROP DATABASE ' + schema); await admin.close();
        fs.rmSync(work, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

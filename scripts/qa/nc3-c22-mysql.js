// NC3/C22: ensayo del retroceso de la base completa contra un MySQL aislado y un testigo externo (datos sintéticos).
// Requiere NC3_QA_MYSQL_PORT y NC3_QA_CONTAINER (contenedor desechable con mysqldump y mysql). Crea y elimina su esquema.
// Capa automática: lo que hace MedSync (firma, conciliador, API de lectura). Capa independiente: lo que mide este guion
// leyendo el archivo del testigo y MySQL directamente. Con NC3_QA_EVIDENCE_DIR escribe c22-results.json.
'use strict';
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Sequelize } = require('sequelize');
const port = Number(process.env.NC3_QA_MYSQL_PORT), container = process.env.NC3_QA_CONTAINER;
if (!port || !container) throw Error('Indica NC3_QA_MYSQL_PORT y NC3_QA_CONTAINER.');
const schema = 'nc3_c22_qa_' + randomBytes(6).toString('hex');
const opts = { host: '127.0.0.1', port, dialect: 'mysql', logging: false };
const admin = new Sequelize('mysql', 'root', '', opts), db = new Sequelize(schema, 'root', '', opts);
const definitions = [
    'doctor_professional_profile (id_login VARCHAR(50),id_business VARCHAR(50),id_doctor_professional_profile VARCHAR(50),professional_name VARCHAR(255),professional_license VARCHAR(100),is_active INT)',
    'person (id_person VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),active INT,code VARCHAR(8),name VARCHAR(80),surname VARCHAR(80), UNIQUE KEY uq_code(code))',
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
    'tracing (id_tracing VARCHAR(50) PRIMARY KEY)', 'patient_code_counter (singleton INT PRIMARY KEY,next_value INT)'
];
const results = [], sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, label = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw Error('timeout ' + label); await sleep(60); } };

async function run() {
    await admin.query('CREATE DATABASE ' + schema + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nc3-c22-'));
    let witnessServer = null, alertServer = null, reconciler = null, server = null;
    try {
        for (const spec of definitions) await db.query('CREATE TABLE ' + spec);
        for (const file of ['nc5-evolution-draft.sql', 'nc5-evolution-signed.sql', 'nc5-performed-extra.sql', 'nc3-evolution-integrity.sql'])
            for (const statement of fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8').replace(/^--.*$/gm, '').split(';')) if (statement.trim()) await db.query(statement);
        for (const sql of [
            'INSERT INTO patient_code_counter VALUES (1,1)',
            "INSERT INTO doctor_professional_profile VALUES ('doctor','clinic','profile','Doctora de prueba','TEST01',1)",
            "INSERT INTO business (id_business,active,status,subscription_status) VALUES ('clinic',1,'active','active'),('other',1,'active','active')",
            "INSERT INTO login VALUES ('doctor','clinic','r','doctor@example.invalid',0,1,'doctor'),('remote','other','r','remote@example.invalid',0,1,'remote')",
            "INSERT INTO rol VALUES ('r','doctor','Doctor',1)", "INSERT INTO session VALUES ('one','doctor',1,1),('two','doctor',1,1),('five','remote',1,1)",
            "INSERT INTO cat_permission VALUES (1,'px.tab.monitoring',1,1,NULL,NULL),(2,'tracing.create',1,1,NULL,NULL),(3,'tracing.correct',1,1,NULL,NULL)",
            "INSERT INTO permission_rol VALUES ('r',1,1),('r',2,1),('r',3,1)"
        ]) await db.query(sql);

        // --- Testigo externo (otro proceso lógico, otro directorio) y canal de Soporte simulado ---
        const witnessDir = path.join(work, 'witness'), spoolPath = path.join(work, 'app-server', 'spool.jsonl');
        const envs = [{ env: 'qa-env', write: randomBytes(12).toString('hex'), support: randomBytes(12).toString('hex') }];
        const { start: startWitness } = require('../ops/nc3-witness-server');
        witnessServer = await startWitness({ dir: witnessDir, envs });
        const alerts = [];
        const startAlertServer = (listenPort = 0) => new Promise(resolve => {
            const s = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { alerts.push({ t: Date.now(), body: JSON.parse(b) }); res.end('ok'); }); });
            s.listen(listenPort, '127.0.0.1', () => resolve(s));
        });
        alertServer = await startAlertServer();
        const alertPort = alertServer.address().port, witnessPort = witnessServer.port;
        const key = randomBytes(32).toString('hex');
        Object.assign(process.env, {
            JWT_SECRET: randomBytes(48).toString('hex'), AUTH_COOKIE_MODE: 'legacy', BROWSER_AUTH_TRANSPORT: 'bearer', CSRF_ENABLED: 'false',
            EVOLUTION_INTEGRITY_KEYS: 'k1:' + key, EVOLUTION_INTEGRITY_KEY_ID: 'k1', EVOLUTION_INTEGRITY_ADOPTION_AT: new Date(Date.now() - 3600e3).toISOString(),
            EVOLUTION_INTEGRITY_LOG_DIR: work, EVOLUTION_INTEGRITY_ANCHOR_PATH: path.join(work, 'anchor.jsonl'),
            EVOLUTION_INTEGRITY_WITNESS_URL: 'http://127.0.0.1:' + witnessPort, EVOLUTION_INTEGRITY_WITNESS_ENV: 'qa-env',
            EVOLUTION_INTEGRITY_WITNESS_WRITE_TOKEN: envs[0].write, EVOLUTION_INTEGRITY_WITNESS_SUPPORT_TOKEN: envs[0].support,
            EVOLUTION_INTEGRITY_WITNESS_SPOOL: spoolPath, EVOLUTION_INTEGRITY_WITNESS_TIMEOUT_MS: '800',
            EVOLUTION_INTEGRITY_ALERT_WEBHOOK_URL: 'http://127.0.0.1:' + alertPort
        });
        const dep = require.resolve('../../src/db/Sequelize.connection');
        require.cache[dep] = { id: dep, filename: dep, loaded: true, exports: db };
        const witness = require('../../src/services/evolutionIntegrityWitness.service');
        const rec = require('../../src/services/evolutionIntegrityReconciler');
        // Medición: cuánto tarda la entrega al testigo y simulación de caída entre el commit y la entrega.
        const latencies = []; let dropNext = false; const realPublish = witness.publish;
        witness.publish = async (...args) => {
            if (dropNext) { dropNext = false; return { state: 'lost' }; }
            const t = process.hrtime.bigint(); const r = await realPublish(...args); latencies.push(Number(process.hrtime.bigint() - t) / 1e6); return r;
        };
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
        let n = 0;
        const newPatient = async () => { const id = 'c22p' + (++n); await db.query("INSERT INTO person (id_person,id_business,active,code,name,surname) VALUES (:id,'clinic',1,:c,'Paciente','Sintético')", { replacements: { id, c: String(300000 + n) } }); return id; };
        const form = { date: '2026-11-20', origin: '', reason: 'Control sintético', evolution: 'Evolución sintética', plan: 'Plan original', none: true, done: [], future: [], performed: '', indication: '' };
        const sign = async (patient, token = A) => {
            const id = randomUUID();
            await call(token, patient, '/evolution-drafts/' + id, { revision: 0, form });
            const r = await call(token, patient, '/evolution-notes/' + id + '/sign', { requestId: randomUUID(), revision: 1 });
            assert.equal(r.status, 200, JSON.stringify(r));
            return { id, r };
        };
        const rectify = (patient, id, revision, plan) => call(A, patient, '/evolution-notes/' + id + '/rectify', { requestId: randomUUID(), revision, reason: 'Corrección sintética', form: { ...form, plan } });
        const wLines = () => { try { return fs.readFileSync(path.join(witnessDir, 'anchors.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
        const wHas = (patient, seq) => wLines().find(l => l.type === 'anchor' && l.rec.patient === patient && l.rec.seq === seq);
        const dump = () => execFileSync('docker', ['exec', container, 'mysqldump', '-uroot', '--single-transaction', '--add-drop-table', '--skip-comments', schema], { maxBuffer: 1 << 28 });
        const restore = buf => execFileSync('docker', ['exec', '-i', container, 'mysql', '-uroot', schema], { input: buf, maxBuffer: 1 << 28 });
        const headSeq = async p => { const [r] = (await db.query('SELECT last_seq FROM evolution_integrity_head WHERE id_person=:p', { replacements: { p } }))[0]; return r ? Number(r.last_seq) : 0; };
        const alertFor = (patient, code) => alerts.find(a => a.body.patient === patient && a.body.code === code);
        const record = (caso, esperado, observado, evidencia) => { results.push({ caso, esperado, observado, evidencia }); console.log('PASS ' + caso); };
        const INTERVAL = 800;
        const makeReconciler = () => rec.install(rec.createReconciler({ db, witnessCfg: witness.config(), staleMs: 3000, unreachableAfter: 2 }));
        reconciler = makeReconciler(); reconciler.start(INTERVAL);
        const clinicalText = /Plan original|Evolución sintética|Control sintético|Plan v2/;

        // ===== Preparación: paciente legítimo, v1 (corte A), v2, nota posterior (corte B) =====
        const P3 = await newPatient(), n3 = await sign(P3); assert.equal(n3.r.data.integrity.external, 'recorded');
        assert.equal((await rectify(P3, n3.id, 1, 'Plan v2 legítimo')).data.integrity.external, 'recorded');
        const P1 = await newPatient(), n1 = await sign(P1);
        assert.equal(n1.r.data.integrity.external, 'recorded'); assert.ok(wHas(P1, 1), 'v1 en el testigo (cotejo independiente)');
        reconciler.stop(); const dumpA = dump(); // corte A: v1 firmada
        const v2 = await rectify(P1, n1.id, 1, 'Plan v2');
        assert.equal(v2.status, 200); assert.equal(v2.data.integrity.external, 'recorded');
        const ackedV2 = wHas(P1, 2); assert.ok(ackedV2, 'la referencia de v2 llegó al testigo (cotejo independiente)');
        const P2 = await newPatient(), n2 = await sign(P2); assert.ok(wHas(P2, 1)); // nota creada después de A
        const dumpB = dump(); // corte B: v2 y la nota posterior
        record('E0 firma, rectificación y referencia externa', 'cada sellado llega al testigo antes de responder', { externalV1: 'recorded', externalV2: 'recorded', witnessSeqP1: [1, 2] }, 'archivo del testigo leído directamente por el guion');
        reconciler.start(INTERVAL, { immediate: false }); await sleep(INTERVAL * 3);
        assert.equal(alerts.length, 0, 'sin falsos positivos antes del retroceso (incluye rectificación legítima)');
        record('E1 rectificación legítima sin falso positivo', 'ningún aviso tras varias conciliaciones', { avisos: 0, conciliaciones: 3 }, 'canal de Soporte simulado vacío');

        // ===== Ensayo decisivo: restaurar la base completa al corte A (nadie abre el expediente) =====
        reconciler.stop(); restore(dumpA);
        assert.equal(await headSeq(P1), 1); // cotejo independiente: MySQL volvió a v1
        const exists2 = (await db.query('SELECT COUNT(*) c FROM person WHERE id_person=:p', { replacements: { p: P2 } }))[0][0].c;
        assert.equal(exists2, 0, 'la nota posterior desapareció por completo');
        const t0 = Date.now(); reconciler.start(INTERVAL, { immediate: false }); // la aplicación sigue en marcha; el conciliador corre por intervalo
        const a1 = await waitFor(() => alertFor(P1, 'ROLLBACK_SUSPECTED'), 15000, 'aviso P1');
        const a2 = await waitFor(() => alertFor(P2, 'ROLLBACK_SUSPECTED'), 15000, 'aviso P2');
        const d1 = a1.t - t0, d2 = a2.t - t0;
        assert.ok(!clinicalText.test(JSON.stringify([a1.body, a2.body])));
        assert.equal(a1.body.witnessSeq, 2); assert.equal(a1.body.databaseSeq, 1); assert.equal(a2.body.databaseSeq, 0);
        assert.ok(!alertFor(P3, 'ROLLBACK_SUSPECTED') && !alerts.some(a => a.body.patient === P3));
        record('E2 restaurar toda la base al corte A (v2 desaparece)', 'Soporte recibe ROLLBACK_SUSPECTED con la referencia del incidente sin abrir el expediente', { codigo: a1.body.code, incidente: a1.body.id, testigoSeq: a1.body.witnessSeq, baseSeq: a1.body.databaseSeq, deteccionMs: d1, intervaloMs: INTERVAL }, 'cotejo independiente: cabecera MySQL seq=1, testigo seq=2');
        record('E3 nota creada después del corte y desaparecida por completo', 'el detector la encuentra aunque el paciente ya no exista en MySQL', { codigo: a2.body.code, incidente: a2.body.id, testigoSeq: a2.body.witnessSeq, baseSeq: a2.body.databaseSeq, deteccionMs: d2 }, 'persona ausente tras restaurar A');
        // lo que ve el profesional y aislamiento
        const read = await call(A, P1, '/evolution-notes');
        assert.equal(read.data.integrity.state, 'discrepancy'); assert.ok(read.data.integrity.faults.includes('ROLLBACK_SUSPECTED'));
        assert.equal(read.data.items[0].form, null);
        const foreign = await call(R, P1, '/evolution-notes'), foreign2 = await call(R, P2, '/evolution-notes/' + n2.id + '/versions');
        assert.equal(foreign.status, 404); assert.equal(foreign2.status, 404);
        assert.deepEqual(rec.shared().faultsFor('other', P1), []);
        const asWrite = await fetch(witness.config().url + '/v1/incidents', { headers: { authorization: 'Bearer ' + envs[0].write } });
        const asNone = await fetch(witness.config().url + '/v1/incidents');
        assert.equal(asWrite.status, 403); assert.equal(asNone.status, 401);
        record('E4 lo que ve el profesional y aislamiento', 'aviso de revisión requerida en el historial afectado; otro consultorio recibe 404 y el testigo no se lee con el token de escritura', { lectura: { estado: read.data.integrity.state, faults: read.data.integrity.faults }, otroConsultorio: [foreign.status, foreign2.status], tokenEscritura: asWrite.status, sinToken: asNone.status }, 'respuesta de la API real');

        // ===== El estado antiguo no se acepta como nueva referencia =====
        const before2 = wHas(P1, 2).rec.mac;
        const n1b = await sign(P1);
        assert.equal(n1b.r.data.integrity.external, 'conflict');
        assert.equal(wHas(P1, 2).rec.mac, before2, 'el testigo conserva la referencia original');
        const dv = await waitFor(() => alertFor(P1, 'HISTORY_DIVERGED'), 15000, 'divergencia');
        assert.ok(wLines().some(l => l.type === 'conflict' && l.rec.patient === P1));
        record('E5 firmar tras el retroceso no sustituye la referencia', 'el testigo rechaza la referencia distinta (409), conserva la original y Soporte recibe HISTORY_DIVERGED', { externo: n1b.r.data.integrity.external, codigo: dv.body.code, macOriginalConservado: true }, 'archivo del testigo: anchor seq=2 original + línea conflict');

        // ===== Recuperación y cierre =====
        reconciler.stop(); restore(dumpB);
        const t1 = Date.now(); reconciler.start(INTERVAL, { immediate: false });
        const incidentsOf = async () => (await witness.incidents(witness.config())).data.events;
        const incidentIds = [a1.body.id, a2.body.id, dv.body.id];
        await waitFor(async () => { const ev = await incidentsOf(); return incidentIds.every(id => ev.some(e => e.id === id && e.type === 'cleared')); }, 15000, 'cleared');
        const clearMs = Date.now() - t1;
        const healed = await call(A, P1, '/evolution-notes/' + n1.id + '/versions');
        assert.equal(healed.data.integrity.state, 'verified'); assert.deepEqual(healed.data.items.map(i => i.integrity.state), ['verified', 'verified']);
        assert.equal(rec.shared().faultsFor('clinic', P1).length, 0);
        const cli = require('../ops/nc3-incident');
        const lines = []; const cliEnv = { ...process.env };
        await assert.rejects(cli.run(['close', a1.body.id, '--by', 'x'], cliEnv, l => lines.push(l)));
        await cli.run(['close', a1.body.id, '--by', 'soporte-qa', '--evidence', 'corte B restaurado; v1 y v2 coinciden con la referencia externa'], cliEnv, l => lines.push(l));
        const trace = (await incidentsOf()).filter(e => e.id === a1.body.id).map(e => e.type);
        assert.deepEqual(trace, ['open', 'delivered', 'cleared', 'closed']);
        record('E6 recuperación al corte B y cierre', 'la condición se anota como resuelta, las dos versiones vuelven a verificarse y el cierre conserva la traza', { traza: trace, resueltoMs: clearMs, lectura: healed.data.integrity.state }, 'eventos del testigo + API');

        // ===== Testigo inaccesible, reintento y concurrencia =====
        reconciler.stop();
        await witnessServer.close();
        const P4 = await newPatient(), n4 = await sign(P4);
        assert.equal(n4.r.data.integrity.external, 'pending'); assert.equal(witness.spoolRead(witness.config()).length, 1);
        alerts.length = 0; reconciler.start(INTERVAL, { immediate: false });
        const un = await waitFor(() => alerts.find(a => a.body.code === 'REFERENCE_UNREACHABLE'), 15000, 'inaccesible');
        const view4 = await call(A, P4, '/evolution-notes');
        assert.equal(view4.data.integrity.state, 'verified'); assert.ok(!alerts.some(a => a.body.severity === 'critical'));
        witnessServer = await startWitness({ dir: witnessDir, envs, port: witnessPort });
        await waitFor(() => wHas(P4, 1), 15000, 'entrega diferida');
        await waitFor(() => witness.spoolRead(witness.config()).length === 0, 5000, 'cola vacía');
        const countBefore = wLines().length;
        await realPublish(witness.config(), { entry: { id_business: 'clinic', id_person: P4, seq: 1, note_id: n4.id, version: 1, format: wHas(P4, 1).rec.format, digest: wHas(P4, 1).rec.digest, previous_digest: null, prev_mac: wHas(P4, 1).rec.prevMac, sealed_at_text: wHas(P4, 1).rec.sealedAt, key_id: 'k1', mac: wHas(P4, 1).rec.mac }, head: { mac: wHas(P4, 1).rec.headMac } });
        assert.equal(wLines().length, countBefore, 'la reentrega no duplica');
        const conc = await Promise.all([A, B].map(t => sign(P4, t)));
        await sleep(INTERVAL * 3);
        assert.ok(conc.every(c => c.r.status === 200)); assert.ok(wHas(P4, 2) && wHas(P4, 3));
        assert.ok(!alerts.some(a => a.body.severity === 'critical'), 'sin falsos positivos tras reintento y concurrencia');
        record('E7 testigo inaccesible, reintento y concurrencia', 'la firma se confirma con la referencia en cola durable, Soporte recibe una advertencia (no una discrepancia), la lectura sigue verificada y la entrega diferida no duplica', { externo: n4.r.data.integrity.external, aviso: un.body.code, severidad: un.body.severity, lecturaDuranteLaCaida: view4.data.integrity.state, reentregaDuplicada: false, concurrentes: conc.map(c => c.r.status) }, 'cola local, archivo del testigo');

        // ===== Reinicio del conciliador con el canal de aviso caído =====
        reconciler.stop(); const dumpC = dump();
        const P5 = await newPatient(), n5 = await sign(P5); assert.ok(wHas(P5, 1));
        await new Promise(r => alertServer.close(r)); alerts.length = 0;
        restore(dumpC); // P5 desaparece; el canal de Soporte está caído
        reconciler = makeReconciler(); reconciler.start(INTERVAL);
        await waitFor(async () => (await incidentsOf()).some(e => e.patient === P5 && e.type === 'open'), 15000, 'incidente P5');
        assert.ok(!(await incidentsOf()).some(e => e.patient === P5 && e.type === 'delivered'));
        reconciler.stop(); reconciler = makeReconciler(); // reinicio: sin memoria
        alertServer = await startAlertServer(alertPort); reconciler.start(INTERVAL);
        const late = await waitFor(() => alertFor(P5, 'ROLLBACK_SUSPECTED'), 15000, 'aviso tras reinicio');
        await waitFor(async () => (await incidentsOf()).some(e => e.patient === P5 && e.type === 'delivered'), 5000, 'delivered');
        const opens = (await incidentsOf()).filter(e => e.patient === P5 && e.type === 'open').length;
        assert.equal(opens, 1); await sleep(INTERVAL * 3);
        assert.equal(alerts.filter(a => a.body.patient === P5 && a.body.code === 'ROLLBACK_SUSPECTED').length, 1, 'un solo aviso entregado');
        record('E8 canal de aviso caído y reinicio del conciliador', 'el incidente queda en el testigo, se entrega al volver el canal tras reiniciar y no se duplica', { incidentesAbiertos: opens, avisosEntregados: 1, incidente: late.body.id }, 'eventos del testigo');

        // ===== Intervalos de exposición medidos =====
        reconciler.stop(); restore(dumpB); // vuelve a un estado conocido (P5 reaparece en B? no: B es anterior); limpiar incidentes del ensayo no es necesario
        const P6 = await newPatient();
        reconciler = makeReconciler();
        dropNext = true; const tCommit = Date.now();
        const n6 = await sign(P6); assert.equal(n6.r.data.integrity.external, 'lost');
        assert.ok(!wHas(P6, 1));
        reconciler.start(INTERVAL, { immediate: false });
        await waitFor(() => wHas(P6, 1), 15000, 'extensión');
        const exposure = Date.now() - tCommit;
        record('E9 caída entre el commit y la entrega (intervalo de exposición)', 'la firma sin referencia externa se completa desde MySQL en la siguiente conciliación', { exposicionMs: exposure, intervaloMs: INTERVAL, regla: 'solo extiende si continúa exactamente el último registro del testigo' }, 'archivo del testigo');
        // límite: cola perdida con el servidor de la aplicación mientras el testigo estaba caído
        reconciler.stop(); const dumpD = dump();
        await witnessServer.close();
        const P7 = await newPatient(), n7 = await sign(P7); assert.equal(n7.r.data.integrity.external, 'pending');
        fs.rmSync(spoolPath); // el servidor de la aplicación se restaura: la cola local se pierde
        restore(dumpD);
        witnessServer = await startWitness({ dir: witnessDir, envs, port: witnessPort });
        alerts.length = 0; reconciler = makeReconciler(); reconciler.start(INTERVAL); await sleep(INTERVAL * 4);
        assert.ok(!wHas(P7, 1)); assert.ok(!alerts.some(a => a.body.patient === P7));
        record('L1 límite: testigo caído y cola local perdida junto con la base', 'NO se detecta: no existe evidencia externa de esa firma (ventana = duración de la caída del testigo)', { detectado: false, firmasSinEvidencia: 1 }, 'testigo sin registro; sin aviso');

        latencies.sort((a, b) => a - b);
        const stats = { entregas: latencies.length, medianaMs: +latencies[Math.floor(latencies.length / 2)].toFixed(2), maxMs: +latencies[latencies.length - 1].toFixed(2) };
        record('M1 costo de la entrega externa en la firma', 'la entrega al testigo ocurre antes de responder y su latencia es acotada', stats, 'temporizador alrededor de la entrega');
        if (process.env.NC3_QA_EVIDENCE_DIR) {
            fs.mkdirSync(process.env.NC3_QA_EVIDENCE_DIR, { recursive: true });
            fs.writeFileSync(path.join(process.env.NC3_QA_EVIDENCE_DIR, 'c22-results.json'), JSON.stringify({ fecha: new Date().toISOString(), entorno: 'MySQL aislado y testigo local, datos sintéticos', intervaloConciliadorMs: INTERVAL, casos: results }, null, 2));
        }
        console.log('PASS NC3/C22: ' + results.length + ' casos.');
    } finally {
        if (reconciler) reconciler.stop();
        if (server) await new Promise(r => server.close(r));
        if (alertServer) await new Promise(r => alertServer.close(r));
        if (witnessServer) await witnessServer.close();
        await db.close(); await admin.query('DROP DATABASE ' + schema); await admin.close();
        fs.rmSync(work, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

// Synthetic mechanics rehearsal only: never loads application config/.env or reads its DB.
// Default --plan has no side effects. --run requires a running Docker engine and creates
// one isolated disposable MySQL container, without published ports or host mounts.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const IMAGE = 'mysql:8.0';
const TABLES = ['patient', 'treatment_plan', 'patient_treatment', 'tracing', 'tracing_revision', 'appointment', 'patient_document', 'attachment'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const plan = {
    scope: 'Synthetic DB and attachment backup/restore mechanics; not application recovery certification',
    source: 'Fresh generated fixtures inside a new isolated MySQL container',
    destination: 'A second fresh database in that disposable container',
    image: IMAGE, network: 'none', publishedPorts: [], hostMounts: [], realDatabaseConnections: 0,
    checks: ['Every table: row contents and CREATE TABLE equality', 'Cross-table foreign keys and tenant relationship consistency',
        'Unicode, JSON snapshots, corrections and annulments retained', 'Stored routine and trigger retained',
        'Attachment DB key and SHA-256 restored', 'Dump and attachment tampering detected'],
    artifacts: '_repo_backups/s18-synthetic-restore-<timestamp>-<random>/ (fictitious data only)',
    productionGaps: ['Actual full schema/application smoke', 'Provider scheduled backups, object versioning, encryption and retention',
        'RPO/RTO measurement at real volume', 'Auth/session/link revocation after a real restore', 'Independent off-host recovery']
};

function guardedArtifact(root, relative) {
    const resolvedRoot = path.resolve(root), target = path.resolve(root, relative);
    if (!relative || path.isAbsolute(relative) || !target.startsWith(resolvedRoot + path.sep)) throw Error('Artifact path outside rehearsal directory');
    return target;
}

function command(args, options = {}) {
    const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: options.timeout || 60000,
        maxBuffer: 20 * 1024 * 1024, input: options.input, env: options.env || process.env });
    if (result.error) throw Error(`Docker unavailable (${result.error.code || 'execution failed'})`);
    if (result.status !== 0) throw Error(`Docker command failed: ${(result.stderr || '').slice(0, 700)}`);
    return result.stdout;
}

async function run() {
    // Refuse before any mutation when the isolated engine is not available.
    command(['info', '--format', '{{.ServerVersion}}'], { timeout: 10000 });
    const nonce = crypto.randomBytes(8).toString('hex'), name = `medsync-s18-restore-${nonce}`;
    assert.match(name, /^medsync-s18-restore-[0-9a-f]{16}$/);
    const password = crypto.randomBytes(32).toString('hex');
    const childEnv = { ...process.env, MYSQL_ROOT_PASSWORD: password, MYSQL_PWD: password };
    const root = path.resolve(__dirname, '../../../_repo_backups', `s18-synthetic-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${nonce}`);
    const report = { ...plan, startedAt: new Date().toISOString(), outcome: 'RUNNING', checksPassed: [], cleanup: null };
    let created = false;
    const sql = (database, input) => command(['exec', '-i', '-e', 'MYSQL_PWD', name, 'mysql', '--protocol=socket', '-uroot',
        '--default-character-set=utf8mb4', '--batch', '--raw', '--skip-column-names', ...(database ? [database] : [])], { input, env: childEnv });
    try {
        await fs.mkdir(root, { recursive: true });
        command(['run', '-d', '--name', name, '--network', 'none', '--label', `medsync.s18.synthetic=${nonce}`,
            '-e', 'MYSQL_ROOT_PASSWORD', IMAGE, '--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', '--event-scheduler=OFF'], { env: childEnv, timeout: 180000 });
        created = true;
        const deadline = Date.now() + 120000;
        let ready = false;
        while (Date.now() < deadline) {
            try { sql(null, 'SELECT 1;'); ready = true; break; } catch (_) { await new Promise(resolve => setTimeout(resolve, 2000)); }
        }
        assert.ok(ready, 'Isolated MySQL initialization timed out');
        report.imageId = command(['inspect', '--format', '{{.Image}}', name]).trim();
        const file = Buffer.from('S18: adjunto ficticio, no contiene datos de pacientes. Áéñ\n', 'utf8');
        const sourceFile = guardedArtifact(root, 'source-assets/synthetic-note.txt');
        await fs.mkdir(path.dirname(sourceFile), { recursive: true });
        await fs.writeFile(sourceFile, file);
        sql(null, 'CREATE DATABASE s18_source CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE DATABASE s18_restored CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');
        sql('s18_source', `
CREATE TABLE patient (id varchar(50) PRIMARY KEY, tenant varchar(50) NOT NULL, name varchar(200) NOT NULL);
CREATE TABLE treatment_plan (id varchar(50) PRIMARY KEY, patient_id varchar(50) NOT NULL, status varchar(30) NOT NULL, FOREIGN KEY(patient_id) REFERENCES patient(id));
CREATE TABLE patient_treatment (id varchar(50) PRIMARY KEY, plan_id varchar(50) NOT NULL, name varchar(200) NOT NULL, FOREIGN KEY(plan_id) REFERENCES treatment_plan(id));
CREATE TABLE tracing (id varchar(50) PRIMARY KEY, patient_id varchar(50) NOT NULL, treatment_id varchar(50), status varchar(30), revision int NOT NULL, note text, FOREIGN KEY(patient_id) REFERENCES patient(id), FOREIGN KEY(treatment_id) REFERENCES patient_treatment(id));
CREATE TABLE tracing_revision (id varchar(50) PRIMARY KEY, tracing_id varchar(50) NOT NULL, revision int NOT NULL, snapshot json NOT NULL, UNIQUE KEY tracing_revision_unique(tracing_id,revision), FOREIGN KEY(tracing_id) REFERENCES tracing(id));
CREATE TABLE appointment (id varchar(50) PRIMARY KEY, patient_id varchar(50) NOT NULL, tracing_id varchar(50), doctor_id varchar(50) NOT NULL, appointment_date date NOT NULL, status varchar(30) NOT NULL, FOREIGN KEY(patient_id) REFERENCES patient(id), FOREIGN KEY(tracing_id) REFERENCES tracing(id));
CREATE TABLE patient_document (id varchar(50) PRIMARY KEY, patient_id varchar(50) NOT NULL, snapshot_html text NOT NULL, signature_fixture varbinary(100), FOREIGN KEY(patient_id) REFERENCES patient(id));
CREATE TABLE attachment (id varchar(50) PRIMARY KEY, patient_id varchar(50) NOT NULL, object_key varchar(200) NOT NULL, sha256 char(64) NOT NULL, FOREIGN KEY(patient_id) REFERENCES patient(id));
INSERT INTO patient VALUES ('patient-a','tenant-a','Paciente ficticio Á'),('patient-b','tenant-b','Paciente ficticio Ñ');
INSERT INTO treatment_plan VALUES ('plan-a','patient-a','active');
INSERT INTO patient_treatment VALUES ('item-a','plan-a','Procedimiento ficticio');
INSERT INTO tracing VALUES ('trace-a','patient-a','item-a','cancelled',2,'Corrección ficticia: revisión conservada.');
INSERT INTO tracing_revision VALUES ('revision-1','trace-a',1,JSON_OBJECT('status','active','note','Contenido ficticio original')),
('revision-2','trace-a',2,JSON_OBJECT('status','cancelled','reason','Anulación ficticia'));
INSERT INTO appointment VALUES ('appointment-a','patient-a','trace-a','doctor-a','2030-01-01','pending_confirmation');
INSERT INTO patient_document VALUES ('document-a','patient-a','<p>Contenido ficticio congelado: ñ.</p>',UNHEX('0001ABFF'));
INSERT INTO attachment VALUES ('attachment-a','patient-a','synthetic-note.txt','${hash(file)}');
CREATE PROCEDURE qa_tracing_count() SELECT COUNT(*) AS total FROM tracing;
CREATE TRIGGER qa_nonempty_name BEFORE INSERT ON patient FOR EACH ROW SET NEW.name=TRIM(NEW.name);
`);
        const expected = {};
        for (const table of TABLES) expected[table] = { rows: sql('s18_source', `SELECT * FROM \`${table}\` ORDER BY id;`), ddl: sql('s18_source', `SHOW CREATE TABLE \`${table}\`;`) };
        const dump = command(['exec', '-e', 'MYSQL_PWD', name, 'mysqldump', '--protocol=socket', '-uroot', '--single-transaction',
            '--routines', '--triggers', '--events', '--set-gtid-purged=OFF', '--no-tablespaces', '--default-character-set=utf8mb4', '--hex-blob', 's18_source'], { env: childEnv });
        const dumpPath = guardedArtifact(root, 'synthetic-database.sql');
        await fs.writeFile(dumpPath, dump);
        const manifest = { syntheticOnly: true, database: { file: 'synthetic-database.sql', sha256: hash(dump) },
            attachments: [{ key: 'synthetic-note.txt', sha256: hash(file), size: file.length }] };
        await fs.writeFile(guardedArtifact(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
        assert.notEqual(hash(dump + '-- QA tampering'), manifest.database.sha256);
        assert.notEqual(hash(Buffer.concat([file, Buffer.from('tampering')])), manifest.attachments[0].sha256);
        const restoreStart = Date.now();
        const backup = await fs.readFile(dumpPath, 'utf8');
        assert.equal(hash(backup), manifest.database.sha256);
        sql('s18_restored', backup);
        for (const table of TABLES) {
            assert.equal(sql('s18_restored', `SELECT * FROM \`${table}\` ORDER BY id;`), expected[table].rows, `${table}: restored rows differ`);
            assert.equal(sql('s18_restored', `SHOW CREATE TABLE \`${table}\`;`), expected[table].ddl, `${table}: restored schema differs`);
        }
        report.checksPassed.push('All eight table contents, primary/foreign keys, indexes and DDL match');
        assert.equal(sql('s18_restored', 'CALL qa_tracing_count();').trim(), '1');
        sql('s18_restored', "INSERT INTO patient VALUES('trigger-probe','tenant-test','  synthetic  ');");
        assert.equal(sql('s18_restored', "SELECT name FROM patient WHERE id='trigger-probe';").trim(), 'synthetic');
        report.checksPassed.push('Procedure executes and trigger normalizes probe text after restore');
        assert.equal(sql('s18_restored', `SELECT COUNT(*) FROM appointment a JOIN tracing t ON t.id=a.tracing_id
            WHERE a.patient_id<>t.patient_id;`).trim(), '0');
        let fkRejected = false;
        try { sql('s18_restored', "INSERT INTO treatment_plan VALUES('orphan','missing','active');"); } catch (_) { fkRejected = true; }
        assert.equal(fkRejected, true, 'Foreign keys must remain enforced after restore');
        report.checksPassed.push('Relations stay consistent and an orphan insert is rejected');
        for (const item of manifest.attachments) {
            const bytes = await fs.readFile(guardedArtifact(root, `source-assets/${item.key}`));
            assert.equal(hash(bytes), item.sha256);
            const target = guardedArtifact(root, `restored-assets/${item.key}`);
            await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
            assert.equal(hash(await fs.readFile(target)), item.sha256);
            assert.equal(sql('s18_restored', 'SELECT sha256 FROM attachment ORDER BY id;').trim(), item.sha256);
        }
        report.checksPassed.push('Attachment object key/DB hash restored; modified dump and file hashes rejected');
        report.restoreMilliseconds = Date.now() - restoreStart;
        report.outcome = 'PASS_SYNTHETIC_MECHANICS_ONLY';
    } catch (error) {
        report.outcome = 'FAILED'; report.error = error.message;
        throw error;
    } finally {
        if (created) {
            try {
                const label = command(['inspect', '--format', '{{index .Config.Labels "medsync.s18.synthetic"}}', name]).trim();
                assert.equal(label, nonce, 'Refuse to remove a container not created by this rehearsal');
                command(['rm', '-f', '-v', name]); report.cleanup = 'Owned synthetic container and its anonymous volumes removed';
            } catch (error) { report.cleanup = `Container cleanup needs review: ${error.message}`; process.exitCode = 1; }
        }
        report.finishedAt = new Date().toISOString();
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(guardedArtifact(root, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ outcome: report.outcome, report: guardedArtifact(root, 'report.json'), checksPassed: report.checksPassed.length, cleanup: report.cleanup }));
    }
}

const mode = process.argv[2] || '--plan';
if (process.argv.length > 3 || !['--plan', '--run', '--self-test'].includes(mode)) throw Error('Use --plan, --self-test or --run only');
if (mode === '--plan') console.log(JSON.stringify(plan, null, 2));
else if (mode === '--self-test') {
    const root = path.resolve('qa-root');
    assert.ok(guardedArtifact(root, 'assets/fixture.txt').startsWith(root + path.sep));
    assert.throws(() => guardedArtifact(root, '../outside'));
    assert.throws(() => guardedArtifact(root, root));
    assert.equal(hash('fictitious'), hash(Buffer.from('fictitious')));
    assert.notEqual(hash('fictitious'), hash('changed'));
    console.log('PASS S18 rehearsal path containment and tamper detection. No Docker, DB connection or files created.');
} else run().catch(error => { console.error('S18 synthetic restore rehearsal:', error.message); process.exitCode = 1; });

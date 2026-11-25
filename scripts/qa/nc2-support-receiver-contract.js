'use strict';
// NC2 · Contrato del aviso a Soporte con el receptor de Alameda TEST (hallazgo 1 de la revisión cruzada de Codex).
// Carga el receptor real (`.tmp-local-dev/c22-soporte-test.cjs` del workspace, o NC2_RECEIVER_FILE) con SES simulado y sus acuses
// en un directorio temporal; escucha sólo en 127.0.0.1. El aviso de NC2 sale del módulo real (`accessAuditSpool`) por su canal
// HTTP real. Sin MySQL, sin correo y sin red externa.
// Uso: node scripts/qa/nc2-support-receiver-contract.js   (NC2_QA_EVIDENCE=<archivo> escribe el resultado en JSON)
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const receiverFile = [process.env.NC2_RECEIVER_FILE, path.resolve(__dirname, '../../../../.tmp-local-dev/c22-soporte-test.cjs'), path.resolve(__dirname, '../../../.tmp-local-dev/c22-soporte-test.cjs')]
    .find(file => file && fs.existsSync(file));
if (!receiverFile) { console.error('No se encontró el receptor de Soporte; defina NC2_RECEIVER_FILE.'); process.exit(2); }

const ENV = 'alameda-test';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nc2-receiver-'));
const sent = [];
const sesStub = {
    SESv2Client: class { async send(command) { sent.push(command.input); return { MessageId: 'qa-' + sent.length }; } },
    SendEmailCommand: class { constructor(input) { this.input = input; } }
};

const freePort = () => new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function loadReceiver(port, token) {
    Object.assign(process.env, { C22_ROUTE_TOKEN: token, EMAIL_CONFIGURATION_SET_TRANSACTIONAL: 'qa-config-set', EMAIL_FROM_NOTIFICATIONS: 'soporte@qa.invalid',
        AWS_REGION: 'us-east-1', C22_RECEIVER_PORT: String(port) });
    const source = fs.readFileSync(receiverFile, 'utf8');
    assert.ok(source.includes("const dir = '/receipts';"), 'el receptor declara su directorio de acuses');
    const receipts = path.join(work, 'receipts'); fs.mkdirSync(receipts);
    const mod = new Module(receiverFile, module);
    mod.filename = receiverFile; mod.paths = Module._nodeModulePaths(path.dirname(receiverFile));
    const original = mod.require.bind(mod);
    // Windows no permite abrir un directorio para fsync; sólo ahí se simula el fsync del directorio de acuses (en Linux es real).
    const DIR_FD = -1;
    const winFs = { ...fs, openSync: (p, flags, mode) => (p === receipts && flags === 'r' ? DIR_FD : fs.openSync(p, flags, mode)),
        fsyncSync: fd => (fd === DIR_FD ? undefined : fs.fsyncSync(fd)), closeSync: fd => (fd === DIR_FD ? undefined : fs.closeSync(fd)) };
    mod.require = id => (id === '@aws-sdk/client-sesv2' ? sesStub : id === 'node:fs' && process.platform === 'win32' ? winFs : original(id));
    mod._compile(source.replace("const dir = '/receipts';", 'const dir = ' + JSON.stringify(receipts) + ';'), receiverFile);
    for (let i = 0; i < 50; i++) { // espera a que escuche
        const up = await new Promise(r => http.request({ host: '127.0.0.1', port, method: 'HEAD', path: '/alerts/' + token }, res => r(res.statusCode === 204)).on('error', () => r(false)).end());
        if (up) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('El receptor no arrancó');
}

const post = (port, token, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/alerts/' + token, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
        res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(data);
});

const results = [];
async function step(id, name, fn) {
    try { const note = await fn(); results.push({ id, result: 'PASS', name, ...(note ? { note } : {}) }); }
    catch (error) { results.push({ id, result: 'FAIL', name, error: error.message }); }
}

async function main() {
    const port = await freePort(), token = crypto.randomBytes(32).toString('hex');
    await loadReceiver(port, token);
    process.env.ACCESS_AUDIT_ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/alerts/${token}`;
    const { createAccessAuditSpool } = require('../../src/services/accessAuditSpool');
    // Bitácora caída simulada: el escritor SQL lanza; el respaldo y el aviso son los reales.
    const failing = { query: async () => { throw Object.assign(new Error('synthetic audit storage failure'), { original: { code: 'ER_SIGNAL_EXCEPTION' } }); } };
    const spool = createAccessAuditSpool({ dir: path.join(work, 'spool'), db: failing, env: ENV });
    let nc2;

    await step('S1', 'El aviso real de NC2 (ambiente de Alameda) es aceptado por el receptor con acuse técnico y asunto propio de NC2', async () => {
        const stored = await spool.record('clinical_history_view', { actor: 'valeria', business: 'biz-alameda', resource: 'ch-a-v2', patient: 'px-a', context: 'detail' });
        assert.equal(stored.stored, 'spool');
        await spool.deliverAlerts();
        const [entry] = spool.outages();
        assert.ok(/^INC-[a-f0-9]{12}$/.test(entry.id), 'referencia INC-: ' + entry.id);
        assert.equal(entry.delivered, true, 'intentos: ' + JSON.stringify(entry.attempts));
        assert.equal(entry.attempts.at(-1).status, 201);
        const mail = sent.at(-1);
        assert.equal(mail.Content.Simple.Subject.Data, '[Alameda TEST] Aviso de bitácora de accesos NC2');
        const text = JSON.stringify(mail);
        assert.ok(text.includes(entry.id) && !text.includes('px-a') && !text.includes('valeria') && !text.includes('ch-a-v2'), 'sin paciente, actor ni recurso');
        nc2 = { env: ENV, id: entry.id, cycle: entry.cycle, code: entry.incident.code };
        return { id: entry.id, ciclo: entry.cycle, codigo: entry.incident.code, estado: entry.attempts.at(-1).status, asunto: mail.Content.Simple.Subject.Data };
    });
    await step('S2', 'Repetir el mismo aviso de NC2 (misma referencia y ciclo) devuelve 200 sin un segundo correo', async () => {
        assert.ok(nc2, 'requiere S1');
        const before = sent.length;
        assert.equal(await post(port, token, nc2), 200);
        assert.equal(sent.length, before);
    });
    await step('S3', 'El control C22 y un incidente de integridad C22 siguen aceptados con sus asuntos de siempre', async () => {
        const id = () => 'INC-' + crypto.randomBytes(6).toString('hex');
        assert.equal(await post(port, token, { env: ENV, id: id(), cycle: 1, code: 'C22_TEST' }), 201);
        assert.equal(sent.at(-1).Content.Simple.Subject.Data, '[Alameda TEST] Prueba del canal C22');
        assert.equal(await post(port, token, { env: ENV, id: id(), cycle: 1, code: 'ROLLBACK_SUSPECTED' }), 201);
        assert.equal(sent.at(-1).Content.Simple.Subject.Data, '[Alameda TEST] Aviso de integridad C22');
    });
    await step('S4', 'Formatos desconocidos siguen rechazados: código ajeno, referencia antigua NC2-ACCESS-, ambiente distinto y ciclo inválido', async () => {
        const base = { env: ENV, id: 'INC-' + crypto.randomBytes(6).toString('hex'), cycle: 1, code: 'ACCESS_AUDIT_SPOOLED' };
        const cases = { codigo: { ...base, code: 'UNKNOWN_CODE' }, referencia: { ...base, id: 'NC2-ACCESS-0215a3a271f8' }, ambiente: { ...base, env: 'nc2-qa' }, ciclo: { ...base, cycle: 0 } };
        const out = {};
        for (const [name, body] of Object.entries(cases)) { out[name] = await post(port, token, body); assert.equal(out[name], 400, name); }
        return out;
    });

    const failed = results.filter(r => r.result === 'FAIL');
    for (const r of results) console.log(`${r.result} ${r.id} ${r.name}${r.error ? ' :: ' + r.error : ''}`);
    console.log(failed.length ? `FAIL: ${failed.length} de ${results.length}` : `PASS: ${results.length} de ${results.length}`);
    if (process.env.NC2_QA_EVIDENCE) fs.writeFileSync(process.env.NC2_QA_EVIDENCE, JSON.stringify({ ranAt: new Date().toISOString(),
        receptor: path.basename(receiverFile), receptorSha256: crypto.createHash('sha256').update(fs.readFileSync(receiverFile)).digest('hex'),
        entorno: 'Receptor local en 127.0.0.1, SES simulado, acuses en directorio temporal; sin correo ni red externa.', results }, null, 2));
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0); // el receptor no expone su servidor para cerrarlo
}

main().catch(error => { console.error(error); process.exit(1); });

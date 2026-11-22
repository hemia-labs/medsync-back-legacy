// NC3/C22: testigo externo de solo-agregar para las referencias de integridad de notas firmadas.
// Se ejecuta FUERA de MySQL y del servidor de MedSync (otro host o volumen). Guarda identificadores y MAC, sin texto clínico.
//   NC3_WITNESS_DIR     carpeta de datos (anchors.jsonl, incidents.jsonl)
//   NC3_WITNESS_PORT    puerto (por defecto 4350)
//   NC3_WITNESS_ENVS    JSON: [{"env":"alameda-test","write":"<token app>","support":"<token Soporte>"}]
// El token de escritura solo agrega referencias. El de Soporte lee referencias e incidentes y agrega eventos de incidente.
// Nadie puede modificar ni borrar por la API. Una referencia distinta para el mismo (env, consultorio, paciente, seq)
// no sustituye a la existente: se conserva ambas y se registra el conflicto.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');

// `hooks` solo para ensayos: delay (ms) retrasa cada respuesta; dropAckOnce registra la referencia y corta la conexión sin acuse.
function start({ dir, port = 0, envs, hooks = {} }) {
    fs.mkdirSync(dir, { recursive: true });
    const anchorsFile = path.join(dir, 'anchors.jsonl'), incidentsFile = path.join(dir, 'incidents.jsonl');
    const index = new Map(), anchors = [], conflicts = [], incidents = [];
    let chain = '0'.repeat(64);
    const load = (file, fn) => { try { for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) fn(JSON.parse(line)); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    const key = r => [r.env, r.business, r.patient, r.seq].join('|');
    load(anchorsFile, line => {
        chain = line.chain;
        if (line.type === 'anchor') { anchors.push(line); index.set(key(line.rec), line.rec); } else conflicts.push(line);
    });
    load(incidentsFile, line => incidents.push(line));
    const append = (file, line) => { const fd = fs.openSync(file, 'a', 0o600); try { fs.writeSync(fd, JSON.stringify(line) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
    const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    const auth = req => {
        const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
        for (const e of envs) {
            if (e.write && same(token, e.write)) return { env: e.env, role: 'write' };
            if (e.support && same(token, e.support)) return { env: e.env, role: 'support' };
        }
        return null;
    };
    const hex = (v, n) => typeof v === 'string' && new RegExp('^[0-9a-f]{' + n + '}$').test(v);
    const valid = r => r && typeof r === 'object' && typeof r.business === 'string' && r.business.length <= 50 && typeof r.patient === 'string' && r.patient.length <= 50
        && Number.isSafeInteger(r.seq) && r.seq > 0 && typeof r.note === 'string' && r.note.length <= 36 && hex(r.mac, 64) && hex(r.headMac, 64) && hex(r.digest, 64) && hex(r.prevMac, 64)
        && (r.previousDigest === null || hex(r.previousDigest, 64)) && typeof r.sealedAt === 'string' && typeof r.keyId === 'string' && typeof r.format === 'string' && Number.isSafeInteger(r.version);
    const server = http.createServer((req, res) => {
        const send = (status, body) => {
            if (hooks.dropAckOnce && req.method === 'POST' && req.url === '/v1/anchors' && [200, 201].includes(status)) { hooks.dropAckOnce = false; return req.socket.destroy(); }
            const go = () => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
            if (hooks.delay) setTimeout(go, hooks.delay); else go();
        };
        const who = auth(req);
        if (!who) return send(401, { error: 'unauthorized' });
        const url = new URL(req.url, 'http://x');
        let raw = '';
        req.on('data', chunk => { raw += chunk; if (raw.length > 65536) req.destroy(); });
        req.on('end', () => {
            let body = null;
            if (raw) { try { body = JSON.parse(raw); } catch { return send(400, { error: 'json' }); } }
            if (req.method === 'POST' && url.pathname === '/v1/anchors') {
                if (who.role !== 'write') return send(403, { error: 'forbidden' });
                if (!valid(body) || body.env !== who.env) return send(400, { error: 'invalid' });
                const k = key(body), existing = index.get(k);
                if (existing) {
                    if (existing.mac === body.mac) return send(200, { status: 'duplicate' });
                    chain = createHash('sha256').update(chain + JSON.stringify(body)).digest('hex');
                    const line = { type: 'conflict', receivedAt: new Date().toISOString(), chain, existingMac: existing.mac, rec: body };
                    append(anchorsFile, line); conflicts.push(line);
                    return send(409, { status: 'conflict' });
                }
                chain = createHash('sha256').update(chain + JSON.stringify(body)).digest('hex');
                const line = { type: 'anchor', receivedAt: new Date().toISOString(), chain, rec: body };
                append(anchorsFile, line); anchors.push(line); index.set(k, body);
                return send(201, { status: 'recorded', receivedAt: line.receivedAt });
            }
            if (who.role !== 'support') return send(403, { error: 'forbidden' });
            if (req.method === 'GET' && url.pathname === '/v1/anchors')
                return send(200, { anchors: anchors.filter(a => a.rec.env === who.env), conflicts: conflicts.filter(c => c.rec.env === who.env) });
            if (req.method === 'GET' && url.pathname === '/v1/incidents') return send(200, { events: incidents.filter(e => e.env === who.env) });
            if (req.method === 'POST' && url.pathname === '/v1/incidents') {
                if (!body || typeof body.id !== 'string' || typeof body.type !== 'string') return send(400, { error: 'invalid' });
                const line = { ...body, env: who.env, receivedAt: new Date().toISOString() };
                append(incidentsFile, line); incidents.push(line);
                return send(201, { status: 'recorded' });
            }
            send(404, { error: 'not_found' });
        });
    });
    return new Promise(resolve => server.listen(port, process.env.NC3_WITNESS_HOST || "127.0.0.1", () => resolve({ server, port: server.address().port, close: () => new Promise(r => server.close(r)) })));
}

if (require.main === module) {
    const envs = JSON.parse(process.env.NC3_WITNESS_ENVS || '[]');
    if (!process.env.NC3_WITNESS_DIR || !envs.length) throw Error('Define NC3_WITNESS_DIR y NC3_WITNESS_ENVS.');
    start({ dir: process.env.NC3_WITNESS_DIR, port: Number(process.env.NC3_WITNESS_PORT) || 4350, envs }).then(s => console.log('NC3_WITNESS_READY ' + s.port));
}
module.exports = { start };

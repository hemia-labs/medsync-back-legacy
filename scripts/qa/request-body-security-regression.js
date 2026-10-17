'use strict';

// Real HTTP/parser regression, with identity and public-token storage simulated.
// No database, cloud, signature delivery or persistent records.
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { defaultBodyParser, protectedBodyParser, publicSignatureBodyParser, policyFor, GENERAL_LIMIT } = require('../../src/middleware/requestBody.middleware');
const publicAccess = require('../../src/middleware/publicSignatureBodyAccess.middleware');
const publicRateLimit = require('../../src/middleware/publicRateLimit.middleware');

const tokenPath = require.resolve('../../src/services/documentSignature/documentSignatureToken.service');
const daoPath = require.resolve('../../src/Dao/mysql/publicDocumentSignature.dao');
const oldToken = require.cache[tokenPath];
const oldDao = require.cache[daoPath];
let tokenQueries = 0;
require.cache[tokenPath] = { id: tokenPath, filename: tokenPath, loaded: true, exports: { hashToken: value => value } };
require.cache[daoPath] = { id: daoPath, filename: daoPath, loaded: true, exports: {
    getRequestByHash: async token => { tokenQueries++; return token[0] === 'a' ? { status: 'pending' } : token[0] === 'b' ? { status: 'revoked' } : token[0] === 'c' ? { status: 'pending', expired: true } : null; },
    requestIsAvailable: row => row && row.status === 'pending',
    requestIsExpired: row => row && row.expired
} };

const app = express();
app.use(defaultBodyParser);
const gate = (req, res, next) => {
    assert.strictEqual(req.body, undefined, 'large payload must not be parsed before identity/tenant checks');
    if (req.headers.authorization !== 'Bearer fixture') return res.status(401).json({ code: 'NO_SESSION' });
    if (req.headers['x-csrf-token'] !== 'fixture') return res.status(403).json({ code: 'CSRF_DENIED' });
    if (req.headers['x-tenant-active'] === 'false') return res.status(403).json({ code: 'TENANT_DENIED' });
    req.tokenDecode = { id_login: 'synthetic-actor' };
    next();
};
const accepted = (req, res) => res.json({ accepted: true, length: (req.body.value || req.body.file || '').length });
app.post('/api/file/px/upload-file', gate, protectedBodyParser, accepted);
app.post('/api/file/px/upload-profile', gate, protectedBodyParser, accepted);
app.post('/api/document/template/save', gate, protectedBodyParser, accepted);
app.post('/api/document/sign', gate, protectedBodyParser, accepted);
app.post('/api/prescription/config/save', gate, protectedBodyParser, accepted);
app.post('/api/public/document-signature/:token/sign', publicRateLimit({ keyPrefix: 'qa-body', maxRequests: 5 }), publicAccess, publicSignatureBodyParser, accepted);
app.post('/api/auth/login', accepted);
app.post('/api/regular', accepted);
app.post('/api/file/px/unknown', accepted);
app.use((err, req, res, next) => res.status(500).json({ code: 'TEST_ERROR', message: err.message }));

function request(port, url, data, options = {}) {
    return new Promise((resolve, reject) => {
        const body = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
        const headers = { 'Content-Type': 'application/json', ...options.headers };
        if (!options.chunked) headers['Content-Length'] = body.length;
        const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(new Error('request timeout')));
        if (options.chunked) { req.write(body.subarray(0, body.length / 2)); req.end(body.subarray(body.length / 2)); }
        else req.end(body);
    });
}

async function run() {
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const port = server.address().port;
    const auth = { headers: { authorization: 'Bearer fixture', 'x-csrf-token': 'fixture' } };
    const large = { value: 'a'.repeat(GENERAL_LIMIT + 1024) };
    let checks = 0;
    const expect = async (url, body, status, options) => {
        const response = await request(port, url, body, options);
        assert.strictEqual(response.status, status, `${url}: ${JSON.stringify(response.body)}`);
        checks++;
        return response;
    };
    try {
        await expect('/api/regular', { value: 'consulta' }, 200);
        const oversized = await expect('/api/regular', large, 413);
        assert.strictEqual(oversized.body.code, 'PAYLOAD_TOO_LARGE');
        await expect('/api/regular', large, 413, { chunked: true });
        await expect('/api/auth/login', { value: 'a'.repeat(33 * 1024) }, 413);
        await expect('/api/file/px/upload-file', '{invalid', 401);
        await expect('/api/file/px/upload-file', '{invalid', 403, { headers: { authorization: 'Bearer fixture' } });
        await expect('/api/file/px/upload-file', '{invalid', 403, { headers: { ...auth.headers, 'x-tenant-active': 'false' } });
        await expect('/api/file/px/upload-file', large, 200, auth);
        await expect('/api/file/px/upload-profile', large, 200, auth);
        await expect('/api/document/template/save', large, 200, auth);
        await expect('/api/document/sign', large, 200, auth);
        await expect('/api/prescription/config/save', large, 200, auth);
        await expect('/api/file/px/upload-profile', { file: 'a'.repeat(4 * GENERAL_LIMIT) }, 413, auth);
        await expect('/api/file/px/upload-file', { file: 'a'.repeat(16 * GENERAL_LIMIT) }, 413, auth);
        await expect('/api/file/px/unknown', large, 413, auth);
        await expect('/api/regular', '{invalid', 400);
        await expect('/api/file/px/upload-file', '{invalid', 400, auth);
        await expect('/api/regular', zlib.gzipSync(JSON.stringify(large)), 415, { headers: { 'Content-Encoding': 'gzip' } });
        await expect('/api/file/px/upload-file', zlib.gzipSync(JSON.stringify(large)), 415, { headers: { ...auth.headers, 'Content-Encoding': 'gzip' } });
        await expect('/api/regular', 'value=' + 'a'.repeat(GENERAL_LIMIT), 413, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        await expect('/api/regular', Array.from({ length: 1001 }, (_, i) => `k${i}=v`).join('&'), 413, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        await expect('/api/public/document-signature/bad/sign', '{invalid', 400);
        assert.strictEqual(tokenQueries, 0, 'invalid token format must not query storage');
        await expect(`/api/public/document-signature/${'b'.repeat(43)}/sign`, '{invalid', 400);
        await expect(`/api/public/document-signature/${'c'.repeat(43)}/sign`, '{invalid', 400);
        await expect(`/api/public/document-signature/${'d'.repeat(43)}/sign`, '{invalid', 400);
        await expect(`/api/public/document-signature/${'a'.repeat(43)}/sign`, large, 200);
        const queriesBeforeLimit = tokenQueries;
        await expect(`/api/public/document-signature/${'a'.repeat(43)}/sign`, '{invalid', 429);
        assert.strictEqual(tokenQueries, queriesBeforeLimit, 'rate limit runs before token lookup and body parsing');

        // Route wiring is security-relevant: every deferred private parser must
        // follow Auth, CSRF and tenant gates, and precede handlers/body validators.
        const root = path.resolve(__dirname, '../../src/routes/mysql');
        const files = ['file.js', 'config.js', 'user.js', 'prescription.js', 'document.js', 'treatment.js', 'px.js'];
        let wired = 0;
        for (const file of files) {
            for (const line of fs.readFileSync(path.join(root, file), 'utf8').split('\n')) {
                if (!line.startsWith('router.') || !line.includes('protectedBodyParser')) continue;
                assert(line.indexOf('Token.Auth,') < line.indexOf('csrfProtected,')
                    && line.indexOf('csrfProtected,') < line.indexOf('requireTenantOperational,')
                    && line.indexOf('requireTenantOperational,') < line.indexOf('protectedBodyParser,'), `${file}: parser ordering`);
                if (line.includes('validatePayload(')) assert(line.indexOf('protectedBodyParser,') < line.indexOf('validatePayload('));
                const match = line.match(/router\.(post|put)\('([^']+)'/);
                const url = '/api/' + file.replace('.js', '') + match[2].replace(':id', 'fixture');
                assert(policyFor({ method: match[1].toUpperCase(), originalUrl: url }), `${url}: parser must have explicit policy`);
                wired++;
            }
        }
        assert.strictEqual(wired, 13);
        console.log(JSON.stringify({ ok: true, httpChecks: checks, protectedRoutesChecked: wired, dbAccess: false }));
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (oldToken) require.cache[tokenPath] = oldToken; else delete require.cache[tokenPath];
        if (oldDao) require.cache[daoPath] = oldDao; else delete require.cache[daoPath];
    }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });

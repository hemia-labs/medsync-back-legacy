'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const security = require('../../src/config/security');
const cookies = require('../../src/config/authCookie.config');
const headers = require('../../src/middleware/securityHeaders.middleware');

const cookieEnv = {
    AUTH_COOKIE_MODE: 'd2', BROWSER_AUTH_TRANSPORT: 'cookie', AUTH_COOKIE_SECURE: 'false',
    AUTH_COOKIE_ACCESS_NAME: 'qa_at', AUTH_COOKIE_REFRESH_NAME: 'qa_rt', AUTH_CSRF_COOKIE_NAME: 'qa_csrf',
    AUTH_COOKIE_SAMESITE: 'lax', AUTH_COOKIE_PATH: '/', AUTH_COOKIE_MAX_AGE_MODE: 'session',
    CSRF_ENABLED: 'true', CORS_CREDENTIALS: 'true', CORS_ALLOWED_ORIGINS: 'https://qa.example.invalid'
};

async function withEnv(env, action) {
    const previous = process.env;
    process.env = { ...env };
    try { return await action(); } finally { process.env = previous; }
}

function request(port, https) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/',
            headers: https ? { 'X-Forwarded-Proto': 'https' } : {} }, res => {
            res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
        });
        req.on('error', reject);
    });
}

async function run() {
    // Real Express HTTP behind a trusted loopback proxy; no env loader, DB or external services.
    const app = express(); app.set('trust proxy', 'loopback');
    app.use(headers.securityHeaders()); app.get('/', (_req, res) => res.sendStatus(204));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    let cases = 0;
    try {
        const scenarios = [
            { APP_ENV: 'development', NODE_ENV: 'production' },
            { APP_ENV: 'production', NODE_ENV: 'development' },
            { APP_ENV: 'development', ENVIRONMENT: 'production', NODE_ENV: 'test' },
            { APP_ENV: 'development', ENVIRONMENT: 'staging', NODE_ENV: ' PrOd ' },
            { APP_ENV: ' PROD ', ENVIRONMENT: 'development', NODE_ENV: 'test' },
            { APP_ENV: 'test', ENVIRONMENT: ' Prod ', NODE_ENV: 'development' }
        ];
        for(const env of scenarios) await withEnv({ ...cookieEnv, ...env }, async () => {
            assert.equal(security.getRuntimeEnv(), 'production');
            assert.equal(security.isProductionLike(), true);
            const config = cookies.getAuthCookieConfig();
            assert.equal(config.productionLike, true, 'Cookies must agree with security for ' + JSON.stringify(env));
            assert.equal(config.runtimeEnv, 'production');
            assert.deepEqual(cookies.validateAuthCookieConfig(config).errors,
                ['AUTH_COOKIE_SECURE=false is invalid in production-like cookie auth'],
                'Reject insecure production cookies independently of __Host- prefix validation');
            assert.throws(() => cookies.validateStartupAuthCookieConfig({ warn() {} }), /AUTH_COOKIE_SECURE=false/);
            assert.equal(cookies.getAuthCookieConfig({ runtimeEnv: 'development' }).productionLike, true,
                'An explicit development label must not weaken a production environment');
            assert.equal(headers.isProductionLikeRuntime(), true);
            const https = await request(server.address().port, true);
            assert.equal(https.status, 204);
            assert.match(https.headers['strict-transport-security'], /^max-age=31536000/);
            assert.equal((await request(server.address().port, false)).headers['strict-transport-security'], undefined);
            process.env.AUTH_COOKIE_SECURE = 'true';
            assert.equal(cookies.validateStartupAuthCookieConfig({ warn() {} }).validation.ok, true);
            assert.equal(cookies.getAccessCookieOptions().secure, true);
            cases++;
        });
        // Preserve explicit local HTTP development and the existing HSTS-only staging policy.
        for(const env of [{}, { APP_ENV: 'development', NODE_ENV: 'test' }, { NODE_ENV: 'staging' }, { ENVIRONMENT: 'stage' }]) {
            await withEnv({ ...cookieEnv, ...env }, async () => {
                assert.equal(security.isProductionLike(), false);
                assert.equal(cookies.getAuthCookieConfig().productionLike, false);
                assert.equal(cookies.validateStartupAuthCookieConfig({ warn() {} }).validation.ok, true);
                const staging = ['staging', 'stage'].includes(security.getRuntimeEnv());
                assert.equal(headers.isProductionLikeRuntime(), staging);
                assert.equal(Boolean((await request(server.address().port, true)).headers['strict-transport-security']), staging);
                assert.equal((await request(server.address().port, false)).headers['strict-transport-security'], undefined);
                cases++;
            });
        }
    } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    console.log('PASS runtime environment: ' + cases + ' scenarios; real cookie/startup validators and HTTP HSTS, both contradictions, aliases, secure acceptance and local/staging compatibility.');
}
module.exports = { run };
if(require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });

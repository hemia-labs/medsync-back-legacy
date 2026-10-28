'use strict';
// No env loader, database, application server or outbound services.
const assert = require('node:assert/strict');
Object.assign(process.env, {
    NODE_ENV: 'test', APP_ENV: 'test', ENVIRONMENT: 'test',
    CSRF_TOKEN_SECRET: 'co25-synthetic-secret-for-isolated-tests-only-0123456789',
    CSRF_TOKEN_TTL_SECONDS: '900'
});
const csrf = require('../../src/services/security/csrfToken.service');
const nowMs = Date.parse('2030-01-01T00:00:00Z');
const session = { tokenDecode: { id_login: 'qa-user', id_session: 'qa-session' } };
const withCookie = (req, token) => ({ ...req, cookies: { [csrf.csrfCookieName()]: token } });
let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }
test('valid same-context cookie reused without extending expiry', () => {
    const first = csrf.issueToken(session, { nowMs });
    const second = csrf.getOrIssueToken(withCookie(session, first.token), { nowMs: nowMs + 5000 });
    assert.equal(second.reused, true);
    assert.equal(second.token, first.token);
    assert.equal(second.expiresAt, first.expiresAt);
    assert.equal(second.contextId, first.contextId);
});
test('near expiry and expired cookies rotate', () => {
    const token = csrf.issueToken(session, { nowMs }).token;
    for (const seconds of [780, 900]) {
        assert.equal(csrf.getOrIssueToken(withCookie(session, token), { nowMs: nowMs + seconds * 1000 }).reused, false);
    }
});
test('preauth/session and session identity transitions rotate', () => {
    const anonymous = csrf.issueToken({}, { nowMs });
    const authenticated = csrf.issueToken(session, { nowMs });
    for (const [req, old] of [[session, anonymous], [{}, authenticated],
        [{ tokenDecode: { id_login: 'qa-user', id_session: 'another-session' } }, authenticated]]) {
        const next = csrf.getOrIssueToken(withCookie(req, old.token), { nowMs });
        assert.equal(next.reused, false);
        assert.notEqual(next.contextId, old.contextId);
    }
});
test('bad signature, malformed, version and context never reused', () => {
    const crypto = require('node:crypto');
    const issued = csrf.issueToken(session, { nowMs });
    const sign = payload => {
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return encoded + '.' + crypto.createHmac('sha256', process.env.CSRF_TOKEN_SECRET).update(encoded).digest('base64url');
    };
    for (const token of ['invalid', issued.token + 'x', sign({ ...issued.payload, v: 'old' }), sign({ ...issued.payload, ctx: 'unknown' })]) {
        assert.equal(csrf.getOrIssueToken(withCookie(session, token), { nowMs }).reused, false);
    }
});
test('short configured TTL does not rotate freshly issued cookies on every GET', () => {
    for (const ttl of [1, 10, 30, 60, 120, 900]) {
        process.env.CSRF_TOKEN_TTL_SECONDS = String(ttl);
        for (const milliseconds of [0, 999]) {
            const at = nowMs + milliseconds;
            const first = csrf.getOrIssueToken(session, { nowMs: at });
            const second = csrf.getOrIssueToken(withCookie(session, first.token), { nowMs: at });
            assert.equal(second.reused, true, 'TTL ' + ttl + ' at ' + milliseconds);
        }
    }
});
console.log('PASS CO25 server: ' + count + ' groups');

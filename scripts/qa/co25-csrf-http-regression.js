'use strict';
const assert = require('node:assert/strict');
const { createFixture } = require('./co25-csrf-http-fixture');
(async () => {
    const f = await createFixture();
    try {
        const access = 'co25_at=' + f.accessCookie();
        const firstResponse = await fetch(f.origin + '/api/auth/csrf', { headers: { Cookie: access } });
        const first = (await firstResponse.json()).data;
        assert.ok(firstResponse.headers.getSetCookie().length);
        const cookie = access + '; co25_csrf=' + first.csrfToken;
        const secondResponse = await fetch(f.origin + '/api/auth/csrf', { headers: { Cookie: cookie } });
        const second = (await secondResponse.json()).data;
        assert.ok(second.csrfToken === first.csrfToken, 'HTTP must reuse valid cookie');
        assert.match(firstResponse.headers.get('cache-control'), /no-store/);
        assert.equal(second.expiresAt, first.expiresAt);
        assert.deepEqual(secondResponse.headers.getSetCookie(), [], 'no cookie lifetime extension');
        console.log('PASS HTTP controller reuses token, preserves expiry, omits Set-Cookie and sets no-store');
        const request = (cookies, token, origin = f.origin) => fetch(f.origin + '/api/appointment/save', {
            method: 'POST', headers: { Cookie: cookies, 'X-CSRF-Token': token, Origin: origin }, body: '{}'
        });
        for (const [cookies, token, origin, reason] of [
            [cookie, 'wrong', f.origin, 'mismatch'], [access, first.csrfToken, f.origin, 'missing_cookie'],
            [cookie, first.csrfToken, 'https://blocked.example.test', 'origin_not_allowed'],
            [access + '; co25_csrf=' + first.csrfToken + 'x', first.csrfToken + 'x', f.origin, 'bad_signature'],
            ['co25_at=' + f.accessCookie('two') + '; co25_csrf=' + first.csrfToken, first.csrfToken, f.origin, 'bad_binding']
        ]) {
            const res = await request(cookies, token, origin);
            assert.equal(res.status, 403);
            assert.equal((await res.json()).reason, reason);
        }
        assert.equal(f.state.effects.length, 0);
        assert.equal((await request(cookie, first.csrfToken)).status, 200);
        assert.equal(f.state.effects.length, 1);
        console.log('PASS HTTP mismatch, missing cookie, origin, signature and binding reject before any write');
        const expired = f.csrf.issueToken({ tokenDecode: f.session() }, { nowMs: Date.now() - 10000, ttlSeconds: 1 });
        const res = await request(access + '; co25_csrf=' + expired.token, expired.token);
        assert.equal((await res.json()).reason, 'expired');
        console.log('PASS HTTP expired token rejected');
    } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

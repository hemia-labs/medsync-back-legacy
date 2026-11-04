'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const sso = require('../../src/auth/platformSso');
const { createSession } = require('../../src/auth/platformSsoSession');
const binding = { sub: 'qa-subject', email: 'operator@example.test', id_login: 'qa-admin' };
function env() { return { NODE_ENV: 'test', APP_ENV: 'test', PLATFORM_SSO_ENABLED: 'true', AUTH_COOKIE_MODE: 'd2',
    BROWSER_AUTH_TRANSPORT: 'cookie', CSRF_ENABLED: 'true', CORS_CREDENTIALS: 'true', CORS_ALLOWED_ORIGINS: 'https://platform.example.test',
    PLATFORM_SSO_ISSUER: 'https://identity.example.test', PLATFORM_SSO_CALLBACK_URL: 'https://platform.example.test/api/platform-auth/callback',
    PLATFORM_FRONTEND_URL: 'https://platform.example.test', PLATFORM_SSO_CLIENT_ID: 'medsync-platform',
    PLATFORM_SSO_CLIENT_SECRET: 'synthetic-client-secret', PLATFORM_SSO_FLOW_KEY: crypto.randomBytes(32).toString('base64'),
    JWT_SECRET: 'test-only-signing-key-with-more-than-32-bytes', PLATFORM_SSO_IDENTITY_BINDINGS_JSON: JSON.stringify([binding]) }; }
const identity = () => ({ sub: binding.sub, email: binding.email, email_verified: true, exp: Math.floor(Date.now()/1000)+600 });

test('configuration fails closed and rejects unsafe origins, duplicate grants and non-D2 transport', () => {
    assert.equal(sso.config({}), null);
    for (const change of [{ PLATFORM_SSO_FLOW_KEY: '' }, { PLATFORM_SSO_IDENTITY_BINDINGS_JSON: '[]' },
        { PLATFORM_SSO_IDENTITY_BINDINGS_JSON: JSON.stringify([binding,binding]) }, { BROWSER_AUTH_TRANSPORT: 'authorization' },
        { PLATFORM_FRONTEND_URL: 'https://evil.example.test' }, { PLATFORM_SSO_ISSUER: 'http://id.example.test' },
        { AUTH_COOKIE_SAMESITE: 'none' }, { PLATFORM_SSO_CALLBACK_URL: 'https://platform.example.test/other' }]) {
        assert.throws(() => sso.config({ ...env(), ...change }));
    }
});
test('encrypted PKCE flow is browser-bound, timed and tamper resistant', () => {
    const c = sso.config(env()), started = sso.startFlow(c), url = new URL(started.url);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), c.callback);
    assert.equal(sso.openFlow(c, started.cookie, started.flow.state).verifier, started.flow.verifier);
    assert.throws(() => sso.openFlow(c, started.cookie, 'wrong-state'));
    assert.throws(() => sso.openFlow(c, started.cookie, started.flow.state, Date.now()+301000));
    assert.throws(() => sso.openFlow(c, started.cookie.slice(0,-8)+'AAAAAAAA', started.flow.state));
    assert.throws(() => sso.openFlow(sso.config(env()), started.cookie, started.flow.state));
    assert.equal(sso.flowOptions(c).httpOnly, true);
});
test('RS256 verification rejects wrong issuer/audience/nonce, expired tokens and unbound identity', async () => {
    const jose = await import('jose'), {privateKey,publicKey} = await jose.generateKeyPair('RS256');
    const c=sso.config(env());
    async function sign(change={}) { return new jose.SignJWT({ ...identity(), nonce:'qa-nonce', ...change }).setProtectedHeader({alg:'RS256'}).setIssuedAt().setIssuer(c.issuer).setAudience(c.clientId).sign(privateKey); }
    assert.equal((await sso.verifyIdentity(c,await sign(),'qa-nonce',publicKey)).sub,binding.sub);
    for (const claims of [{nonce:'other'}, {email_verified:false}, {sub:'other'}, {email:'different@example.test'}, {exp:1}, {azp:'other'}]) {
        await assert.rejects(sso.verifyIdentity(c,await sign(claims),'qa-nonce',publicKey));
    }
    await assert.rejects(sso.verifyIdentity({...c,issuer:'https://other.example.test'},await sign(),'qa-nonce',publicKey));
    await assert.rejects(sso.verifyIdentity({...c,clientId:'other'},await sign(),'qa-nonce',publicKey));
    const hs = jwt.sign({...identity(),nonce:'qa-nonce',iss:c.issuer,aud:c.clientId},'synthetic-key',{algorithm:'HS256'});
    await assert.rejects(sso.verifyIdentity(c,hs,'qa-nonce',publicKey));
});
test('each request rechecks exact identity grant, current role, email, lock and enabled flag', () => {
    const settings=env(), c=sso.config(settings), claims={auth_method:'hemia_sso',sso_sub:binding.sub,sso_issuer:c.issuer};
    const user={id_login:binding.id_login, email:binding.email,rol:'super_admin',locked:0};
    assert.equal(sso.principalAllowed(claims,user,settings),true);
    for (const patch of [{rol:'admin'}, {locked:1}, {email:'other@example.test'}, {id_login:'other'}]) assert.equal(sso.principalAllowed(claims,{...user,...patch},settings),false);
    assert.equal(sso.principalAllowed(claims,user,{...settings,PLATFORM_SSO_ENABLED:'false'}),false);
    assert.equal(sso.principalAllowed({},user,{}),true);
});
function database(user, failAudit=false) {
    const queries=[]; let committed=false,rolledBack=false;
    const db={transaction:async fn=>{try{const result=await fn('tx');committed=true;return result}catch(e){rolledBack=true;throw e}},query:async(sql,options)=>{
        assert.equal(options.transaction,'tx');queries.push(sql);
        if(sql.includes('FOR UPDATE'))return user?[user]:[];
        if(sql.includes('next_sec'))return [{next_sec:2}];
        return [];
    }};
    const audit={record:async(_action,_context,options)=>{assert.equal(options.strict,true);assert.equal(options.transaction,'tx');if(failAudit)throw Error('synthetic audit failure')}};
    return {db,audit,queries,state:()=>({committed,rolledBack})};
}
test('session creation is atomic, revokes old refresh sessions, audits and bounds TTL without provisioning', async () => {
    const settings=env(), c=sso.config(settings), user={...binding,active:1,locked:0,rol:'super_admin',id_business:null};
    const mock=database(user), result=await createSession(c,identity(),mock.db,settings.JWT_SECRET,mock.audit);
    const claims=jwt.verify(result.token,settings.JWT_SECRET,{algorithms:['HS256']});
    assert.equal(claims.auth_method,'hemia_sso');assert.equal(claims.id_login,binding.id_login);
    assert.ok(claims.exp-claims.iat<=600);assert.equal(mock.state().committed,true);
    assert.ok(mock.queries.some(q=>q.includes('UPDATE refresh_token')));
    assert.ok(!mock.queries.some(q=>/INSERT INTO login|UPDATE login/.test(q)));
    for(const change of [{active:0},{locked:1},{rol:'admin'},{email:'other@example.test'}]){
        const denied=database({...user,...change});await assert.rejects(createSession(c,identity(),denied.db,settings.JWT_SECRET,denied.audit));
        assert.equal(denied.queries.length,1);assert.equal(denied.state().rolledBack,true);
    }
    const broken=database(user,true);await assert.rejects(createSession(c,identity(),broken.db,settings.JWT_SECRET,broken.audit));assert.equal(broken.state().rolledBack,true);
});
test('HTTP login/callback sets only host cookies and never returns provider tokens; invalid flow cannot issue session', async () => {
    const express=require('express'), app=express(), c=sso.config(env()); let issued=0, exchanges=0;
    app.use(require('cookie-parser')());
    app.use('/api/platform-auth',require('../../src/routes/mysql/platform-auth').createRouter({getConfig:()=>c,
        exchange:async()=>{exchanges++;return identity()},issueSession:async()=>{issued++;return {token:'synthetic-d2-token',ttl:600}}}));
    const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${server.address().port}/api/platform-auth`;
    try {
        const login=await fetch(base+'/login',{redirect:'manual'}), cookie=login.headers.getSetCookie()[0].split(';')[0];
        assert.equal(login.status,303);const state=new URL(login.headers.get('location')).searchParams.get('state');
        const bad=await fetch(base+'/callback?code=synthetic&state=bad',{redirect:'manual',headers:{cookie}});
        assert.equal(issued,0);assert.equal(exchanges,0);assert.ok(bad.headers.get('location').endsWith('reason=sso_failed'));
        const success=await fetch(base+`/callback?code=synthetic&state=${state}`,{redirect:'manual',headers:{cookie}});
        assert.equal(success.status,303);assert.equal(success.headers.get('location'),c.frontend+'/');assert.equal(issued,1);
        const set=success.headers.getSetCookie();assert.ok(set.some(v=>v.includes('__Host-medsync_at=synthetic-d2-token')&&v.includes('HttpOnly')&&v.includes('Secure')));
        assert.ok(set.some(v=>v.startsWith('__Host-medsync_rt=;')));
        const missing=await fetch(base+`/callback?code=synthetic&state=${state}`,{redirect:'manual'});assert.equal(issued,1);assert.equal(missing.status,303);
    } finally { await new Promise(r=>server.close(r)); }
});
test('callback secrets are removed before access logging',()=>{
    const sanitize=require('../../src/middleware/sanitizePublicTokenLogs.middleware').sanitizePublicSignatureToken;
    assert.equal(sanitize('/api/platform-auth/callback?code=secret&state=secret'),'/api/platform-auth/callback?[redacted]');
});

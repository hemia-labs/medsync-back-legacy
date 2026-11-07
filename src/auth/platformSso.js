'use strict';

const crypto = require('node:crypto');
const cookies = require('../config/authCookie.config');
const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_SESSION_SECONDS = 15 * 60;
const jwksCache = new Map();

function config(env = process.env) {
    if (env.PLATFORM_SSO_ENABLED !== 'true') return null;
    const cookie = cookies.assertAuthCookieConfig(cookies.getAuthCookieConfig({ env }));
    if (!cookie.isCookieAuthEnabled) throw new Error('Platform SSO requires D2 cookie authentication');
    function url(name) {
        const result = new URL(env[name]);
        if (result.username || result.password || result.search || result.hash ||
            (result.protocol !== 'https:' && !(result.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(result.hostname) && !cookie.productionLike))) {
            throw new Error('Invalid platform SSO URL configuration');
        }
        return result;
    }
    const issuer = url('PLATFORM_SSO_ISSUER').href.replace(/\/$/, '');
    const callback = url('PLATFORM_SSO_CALLBACK_URL');
    const frontend = url('PLATFORM_FRONTEND_URL');
    if (callback.pathname !== '/api/platform-auth/callback' || frontend.pathname !== '/' ||
        !cookie.cors.origins.includes(frontend.origin) || cookie.domain || cookie.path !== '/' || cookie.sameSite !== 'lax') {
        throw new Error('Platform SSO requires fixed callback, frontend origin and host-only Lax cookies');
    }
    const flowKey = Buffer.from(env.PLATFORM_SSO_FLOW_KEY || '', 'base64');
    if (flowKey.length !== 32 || !env.PLATFORM_SSO_CLIENT_ID || !env.PLATFORM_SSO_CLIENT_SECRET || !env.JWT_SECRET || env.JWT_SECRET.length < 32) {
        throw new Error('Platform SSO credentials are incomplete');
    }
    const bindings = JSON.parse(env.PLATFORM_SSO_IDENTITY_BINDINGS_JSON || '[]');
    if (!Array.isArray(bindings) || !bindings.length || bindings.some(b => !b || typeof b.sub !== 'string' || !b.sub.trim() || typeof b.email !== 'string' || !b.email.includes('@') || typeof b.id_login !== 'string' || !b.id_login.trim()) ||
        new Set(bindings.map(b => b.sub)).size !== bindings.length || new Set(bindings.map(b => b.id_login)).size !== bindings.length) {
        throw new Error('Platform SSO requires unique explicit identity bindings');
    }
    return { issuer, callback: callback.href, frontend: frontend.origin, clientId: env.PLATFORM_SSO_CLIENT_ID,
        clientSecret: env.PLATFORM_SSO_CLIENT_SECRET, flowKey, bindings, cookie,
        flowCookie: cookie.secure ? '__Host-medsync_sso' : 'medsync_sso_dev' };
}

function bindingFor(c, claims) {
    if (!c || !claims || claims.email_verified !== true || typeof claims.email !== 'string') return null;
    return c.bindings.find(b => b.sub === claims.sub && b.email.toLowerCase() === claims.email.toLowerCase()) || null;
}

function flowOptions(c) { return { httpOnly: true, secure: c.cookie.secure, sameSite: 'lax', path: '/', maxAge: FLOW_TTL_MS }; }
function sealFlow(c, flow) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', c.flowKey, iv);
    cipher.setAAD(Buffer.from(c.clientId + '|' + c.callback));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(flow)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
function openFlow(c, value, state, now = Date.now()) {
    if (typeof value !== 'string' || value.length > 4096 || typeof state !== 'string' || state.length > 128) throw new Error('Invalid SSO flow');
    const raw = Buffer.from(value, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', c.flowKey, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(c.clientId + '|' + c.callback));
    decipher.setAuthTag(raw.subarray(12, 28));
    const flow = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
    if (flow.state !== state || !Number.isFinite(flow.created) || flow.created > now || now - flow.created > FLOW_TTL_MS || !flow.nonce || !flow.verifier) throw new Error('Expired or mismatched SSO flow');
    return flow;
}
function startFlow(c) {
    const random = () => crypto.randomBytes(32).toString('base64url');
    const flow = { state: random(), nonce: random(), verifier: random(), created: Date.now() };
    const url = new URL(c.issuer + '/oauth/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: c.callback,
        scope: 'openid profile email', state: flow.state, nonce: flow.nonce,
        code_challenge: crypto.createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return { flow, cookie: sealFlow(c, flow), url: url.href };
}
async function verifyIdentity(c, token, nonce, key) {
    const jose = await import('jose');
    let resolver = key;
    if (!resolver) {
        if (!jwksCache.has(c.issuer)) {
            if (jwksCache.size > 4) jwksCache.clear();
            jwksCache.set(c.issuer, jose.createRemoteJWKSet(new URL(c.issuer + '/.well-known/jwks.json'), { timeoutDuration: 5000 }));
        }
        resolver = jwksCache.get(c.issuer);
    }
    const { payload } = await jose.jwtVerify(token, resolver, { issuer: c.issuer, audience: c.clientId,
        algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'nonce'], maxTokenAge: '5m', clockTolerance: 5 });
    if (payload.nonce !== nonce || (payload.azp && payload.azp !== c.clientId) ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== c.clientId) || !bindingFor(c, payload)) {
        throw new Error('Identity is not authorized');
    }
    return payload;
}
async function exchange(c, code, flow) {
    const response = await fetch(c.issuer + '/oauth/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: c.clientId, client_secret: c.clientSecret,
            redirect_uri: c.callback, code_verifier: flow.verifier }) });
    if (!response.ok) throw new Error('SSO code exchange failed');
    const data = await response.json();
    if (typeof data.id_token !== 'string') throw new Error('Missing identity token');
    return verifyIdentity(c, data.id_token, flow.nonce);
}
function principalAllowed(claims, current, env = process.env) {
    if (claims.auth_method !== 'hemia_sso') return true;
    try {
        const c = config(env);
        const binding = bindingFor(c, { sub: claims.sso_sub, email: current.email, email_verified: true });
        return !!binding && claims.sso_issuer === c.issuer && binding.id_login === current.id_login && current.rol === 'super_admin' && !current.locked;
    } catch { return false; }
}
module.exports = { config, bindingFor, flowOptions, sealFlow, openFlow, startFlow, verifyIdentity, exchange, principalAllowed, MAX_SESSION_SECONDS };

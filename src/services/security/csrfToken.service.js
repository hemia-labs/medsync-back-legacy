'use strict';

const crypto = require('crypto');
const AuthCookieConfig = require('../../config/authCookie.config');
const SecurityConfig = require('../../config/security');

const TOKEN_VERSION = 'csrf-v1';
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function base64Url(value) {
    return Buffer.from(value)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function fromBase64Url(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function hmac(value) {
    return crypto
        .createHmac('sha256', SecurityConfig.getCsrfTokenSecret())
        .update(String(value || ''), 'utf8')
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function hash(value) {
    return crypto
        .createHash('sha256')
        .update(String(value || ''), 'utf8')
        .digest('hex');
}

function safeCompare(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');

    if (a.length !== b.length) {
        return false;
    }

    return crypto.timingSafeEqual(a, b);
}

function safeMethod(method) {
    return SAFE_METHODS.includes(String(method || '').toUpperCase());
}

function headerValue(req, name) {
    const headers = req && req.headers ? req.headers : {};
    const target = String(name || '').toLowerCase();
    const key = Object.keys(headers).find((item) => String(item).toLowerCase() === target);
    return key ? headers[key] : null;
}

function originFromReferer(referer) {
    try {
        return referer ? new URL(referer).origin : null;
    } catch (error) {
        return null;
    }
}

function getRequestOrigin(req) {
    return headerValue(req, 'origin') || originFromReferer(headerValue(req, 'referer'));
}

function getContextType(req) {
    return req && req.tokenDecode && req.tokenDecode.id_login && req.tokenDecode.id_session
        ? 'session'
        : 'preauth';
}

function bindingMaterial(contextType, req) {
    if (contextType === 'session') {
        const tokenDecode = req && req.tokenDecode ? req.tokenDecode : {};
        return `session:${tokenDecode.id_login}:${tokenDecode.id_session}`;
    }

    return 'preauth:v1';
}

function buildPayload(req, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const ttlSeconds = Number.isFinite(options.ttlSeconds)
        ? options.ttlSeconds
        : SecurityConfig.getCsrfTokenTtlSeconds();
    const contextType = options.contextType || getContextType(req);
    const expiresAtMs = nowMs + (ttlSeconds * 1000);

    return {
        v: TOKEN_VERSION,
        nonce: crypto.randomBytes(24).toString('hex'),
        iat: Math.floor(nowMs / 1000),
        exp: Math.floor(expiresAtMs / 1000),
        ctx: contextType,
        binding: hash(bindingMaterial(contextType, req))
    };
}

function issueToken(req, options = {}) {
    const payload = buildPayload(req, options);
    const encodedPayload = base64Url(JSON.stringify(payload));
    const signature = hmac(encodedPayload);

    return {
        token: `${encodedPayload}.${signature}`,
        payload,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
        contextType: payload.ctx,
        contextId: hmac(`csrf-context:${payload.ctx}:${payload.binding}`)
    };
}

function parseToken(rawToken) {
    const parts = String(rawToken || '').split('.');

    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return null;
    }

    try {
        return {
            encodedPayload: parts[0],
            signature: parts[1],
            payload: JSON.parse(fromBase64Url(parts[0]))
        };
    } catch (error) {
        return null;
    }
}

function validateToken(rawToken, req, options = {}) {
    const parsed = parseToken(rawToken);
    const nowSeconds = Number.isFinite(options.nowSeconds)
        ? options.nowSeconds
        : Math.floor(Date.now() / 1000);

    if (!parsed || !parsed.payload) {
        return { ok: false, reason: 'malformed' };
    }

    const expectedSignature = hmac(parsed.encodedPayload);
    if (!safeCompare(expectedSignature, parsed.signature)) {
        return { ok: false, reason: 'bad_signature' };
    }

    const payload = parsed.payload;
    if (payload.v !== TOKEN_VERSION) {
        return { ok: false, reason: 'bad_version' };
    }

    if (!payload.exp || Number(payload.exp) <= nowSeconds) {
        return { ok: false, reason: 'expired' };
    }

    if (!['preauth', 'session'].includes(payload.ctx)) {
        return { ok: false, reason: 'bad_context' };
    }

    const expectedBinding = hash(bindingMaterial(payload.ctx, req));
    if (!safeCompare(expectedBinding, payload.binding)) {
        return { ok: false, reason: 'bad_binding' };
    }

    return {
        ok: true,
        payload: {
            contextType: payload.ctx,
            expiresAt: new Date(payload.exp * 1000).toISOString(),
            contextId: hmac(`csrf-context:${payload.ctx}:${payload.binding}`)
        }
    };
}

function getOrIssueToken(req, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const ttlSeconds = SecurityConfig.getCsrfTokenTtlSeconds();
    // Scale down for short configured lifetimes instead of rotating every GET.
    // exp is stored in whole seconds, so account for that rounding at TTL=1.
    const renewalWindowMs = Math.min(120000, Math.max(0, ttlSeconds - 1) * 1000 / 4);
    const token = req && req.cookies ? req.cookies[csrfCookieName()] : null;
    const validated = validateToken(token, req, { nowSeconds: Math.floor(nowMs / 1000) });
    if (validated.ok && validated.payload.contextType === getContextType(req)
        && Date.parse(validated.payload.expiresAt) - nowMs > renewalWindowMs) {
        return { token, ...validated.payload, reused: true };
    }
    return { ...issueToken(req, { nowMs, ttlSeconds }), reused: false };
}

function csrfCookieName() {
    const config = AuthCookieConfig.getAuthCookieConfig();
    return AuthCookieConfig.getCookieNames(config).csrf;
}

function csrfCookieOptions() {
    const config = AuthCookieConfig.assertAuthCookieConfig();
    return AuthCookieConfig.getCsrfCookieOptions(config);
}

function validateOrigin(req) {
    if (!SecurityConfig.isCsrfOriginCheckEnabled() || safeMethod(req ? req.method : null)) {
        return { ok: true };
    }

    const requestOrigin = getRequestOrigin(req);
    const allowedOrigins = SecurityConfig.getCsrfAllowedOrigins();

    if (!requestOrigin) {
        return SecurityConfig.isProductionLike()
            ? { ok: false, reason: 'missing_origin' }
            : { ok: true, reason: 'missing_origin_allowed_local' };
    }

    if (allowedOrigins.length === 0 && !SecurityConfig.isProductionLike()) {
        return { ok: true, reason: 'no_allowlist_allowed_local' };
    }

    if (!allowedOrigins.includes(requestOrigin)) {
        return { ok: false, reason: 'origin_not_allowed' };
    }

    return { ok: true };
}

function validateDoubleSubmit(req, options = {}) {
    if (!SecurityConfig.isCsrfEnabled()) {
        return { ok: true, skipped: true };
    }

    if (safeMethod(req ? req.method : null)) {
        return { ok: true, skipped: true };
    }

    const origin = validateOrigin(req);
    if (!origin.ok) {
        return origin;
    }

    const cookieName = csrfCookieName();
    const headerName = SecurityConfig.getCsrfHeaderName();
    const cookieToken = req && req.cookies ? req.cookies[cookieName] : null;
    const headerToken = headerValue(req, headerName);

    if (!cookieToken) {
        return { ok: false, reason: 'missing_cookie' };
    }

    if (!headerToken) {
        return { ok: false, reason: 'missing_header' };
    }

    if (!safeCompare(cookieToken, headerToken)) {
        return { ok: false, reason: 'mismatch' };
    }

    return validateToken(headerToken, req, options);
}

function safeTokenSummary(rawToken) {
    const fingerprint = hash(rawToken || '').slice(0, 12);

    return {
        present: Boolean(rawToken),
        length: rawToken ? String(rawToken).length : 0,
        fingerprint12: rawToken ? fingerprint : null
    };
}

module.exports = {
    csrfCookieName,
    csrfCookieOptions,
    getOrIssueToken,
    issueToken,
    safeMethod,
    safeTokenSummary,
    validateDoubleSubmit,
    validateOrigin,
    validateToken
};

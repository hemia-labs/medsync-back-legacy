'use strict';
const { createHmac, timingSafeEqual, randomBytes } = require('node:crypto');
const AuthCookies = require('../../config/authCookie.config');
const { RegistrationError } = require('./errors');
function key() {
    const value = process.env.REGISTRATION_HMAC_KEY || '';
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new RegistrationError('REGISTRATION_UNAVAILABLE', 503);
    return Buffer.from(value, 'hex');
}
const mac = (purpose, value) => createHmac('sha256', key()).update(purpose + '\0' + value).digest('hex');
function equal(a, b) {
    const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''));
    return left.length === right.length && timingSafeEqual(left, right);
}
function cookieSettings() {
    const config = AuthCookies.assertAuthCookieConfig();
    return { name: config.secure ? '__Host-medsync_registration' : 'medsync_registration_dev',
        options: { httpOnly: true, secure: config.secure, sameSite: 'strict', path: '/', maxAge: 86400000 } };
}
function readAttempt(req) {
    const raw = req.cookies && req.cookies[cookieSettings().name];
    if (typeof raw !== 'string' || raw.length > 200) return null;
    const [expiry, secret, signature, extra] = raw.split('.');
    if (extra || !/^\d{13}$/.test(expiry || '') || !/^[a-f0-9]{64}$/.test(secret || '')
        || Number(expiry) <= Date.now() || Number(expiry) > Date.now() + 86401000
        || !equal(mac('attempt-cookie-v1', expiry + '.' + secret), signature)) return null;
    return { secret, expiresAt: new Date(Number(expiry)).toISOString() };
}
function issueAttempt(req, res) {
    const previous = readAttempt(req);
    if (previous) return previous; // Reload never extends the reservation window.
    const expiry = String(Date.now() + 86400000), secret = randomBytes(32).toString('hex');
    const {name, options} = cookieSettings();
    res.cookie(name, expiry + '.' + secret + '.' + mac('attempt-cookie-v1', expiry + '.' + secret), options);
    return { secret, expiresAt: new Date(Number(expiry)).toISOString() };
}
function exact(body, keys) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== keys.length
        || keys.some(k => !Object.hasOwn(body,k))) throw new RegistrationError('INVALID_REGISTRATION');
}
module.exports = { mac, equal, key, cookieSettings, readAttempt, issueAttempt, exact };

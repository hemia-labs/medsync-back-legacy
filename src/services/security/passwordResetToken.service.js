'use strict';

const crypto = require('crypto');
const SecurityConfig = require('../../config/security');

const NUMERIC_ALPHABET = '0123456789';
const ALPHANUMERIC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PURPOSE = 'password_reset';

function getAlphabet() {
    return SecurityConfig.getPasswordResetCodeAlphabet() === 'alphanumeric'
        ? ALPHANUMERIC_ALPHABET
        : NUMERIC_ALPHABET;
}

function generateCode() {
    const alphabet = getAlphabet();
    const length = SecurityConfig.getPasswordResetCodeLength();
    let code = '';

    for (let index = 0; index < length; index += 1) {
        code += alphabet[crypto.randomInt(0, alphabet.length)];
    }

    return code;
}

function normalizePhone(phone) {
    return String(phone || '').replace(/\D/g, '');
}

function normalizeCode(code) {
    return String(code || '').trim().toUpperCase();
}

function hashCode(phone, code) {
    const message = `${PURPOSE}:${normalizePhone(phone)}:${normalizeCode(code)}`;

    return crypto
        .createHmac('sha256', SecurityConfig.getPasswordResetCodeSecret())
        .update(message)
        .digest('hex');
}

function fingerprintFromHash(hash) {
    return crypto
        .createHash('sha256')
        .update(String(hash || ''))
        .digest('hex')
        .slice(0, 32);
}

function fingerprintEmail(email) {
    const value = String(email || '').trim().toLowerCase();

    if (!value) {
        return null;
    }

    return crypto
        .createHmac('sha256', SecurityConfig.getPasswordResetCodeSecret())
        .update(`email:${value}`)
        .digest('hex');
}

function maskEmail(email) {
    const value = String(email || '').trim();
    const atIndex = value.indexOf('@');

    if (atIndex <= 0) {
        return null;
    }

    const local = value.slice(0, atIndex);
    const domain = value.slice(atIndex + 1);
    const visibleLocal = local.length <= 2 ? local[0] : `${local[0]}${local.slice(-1)}`;

    return `${visibleLocal}***@${domain}`;
}

function getExpiresAt(now = new Date()) {
    return new Date(now.getTime() + SecurityConfig.getPasswordResetCodeTtlMinutes() * 60 * 1000);
}

function isExpired(expiresAt, now = new Date()) {
    return !expiresAt || new Date(expiresAt).getTime() <= now.getTime();
}

function safeCompareHash(left, right) {
    const leftBuffer = Buffer.from(String(left || ''), 'hex');
    const rightBuffer = Buffer.from(String(right || ''), 'hex');

    if (leftBuffer.length !== rightBuffer.length || leftBuffer.length === 0) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildCodeRecord(phone, code = generateCode(), now = new Date()) {
    const codeHash = hashCode(phone, code);

    return {
        code,
        code_hash: codeHash,
        code_fingerprint: fingerprintFromHash(codeHash),
        issued_at: now,
        expires_at: getExpiresAt(now),
        max_attempts: SecurityConfig.getPasswordResetMaxAttempts()
    };
}

module.exports = {
    PURPOSE,
    buildCodeRecord,
    fingerprintEmail,
    fingerprintFromHash,
    generateCode,
    getExpiresAt,
    hashCode,
    isExpired,
    maskEmail,
    normalizeCode,
    normalizePhone,
    safeCompareHash
};

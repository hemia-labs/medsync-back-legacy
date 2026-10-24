'use strict';

const crypto = require('crypto');
const SecurityConfig = require('../../config/security');
const PasswordResetTokenService = require('./passwordResetToken.service');

const PURPOSE = 'password_change';
const MAX_CODE_TTL_MINUTES = 10;

function getCodeTtlMinutes() {
    return Math.min(SecurityConfig.getPasswordResetCodeTtlMinutes(), MAX_CODE_TTL_MINUTES);
}

function normalizeIdentity(idLogin) {
    return String(idLogin || '').trim().toLowerCase();
}

function hashCode(idLogin, code) {
    const message = `${PURPOSE}:${normalizeIdentity(idLogin)}:${PasswordResetTokenService.normalizeCode(code)}`;

    return crypto
        .createHmac('sha256', SecurityConfig.getPasswordResetCodeSecret())
        .update(message)
        .digest('hex');
}

function fingerprintPasswordHash(passwordHash) {
    return crypto
        .createHash('sha256')
        .update(String(passwordHash || ''), 'utf8')
        .digest('hex');
}

function buildCodeRecord(idLogin, code = PasswordResetTokenService.generateCode()) {
    const codeHash = hashCode(idLogin, code);
    const ttlMinutes = getCodeTtlMinutes();

    return {
        code,
        ttl_minutes: ttlMinutes,
        code_hash: codeHash,
        code_fingerprint: PasswordResetTokenService.fingerprintFromHash(codeHash),
        max_attempts: SecurityConfig.getPasswordResetMaxAttempts()
    };
}

module.exports = {
    PURPOSE,
    MAX_CODE_TTL_MINUTES,
    buildCodeRecord,
    fingerprintEmail: PasswordResetTokenService.fingerprintEmail,
    fingerprintPasswordHash,
    getCodeTtlMinutes,
    hashCode,
    isExpired: PasswordResetTokenService.isExpired,
    maskEmail: PasswordResetTokenService.maskEmail,
    safeCompareHash: PasswordResetTokenService.safeCompareHash
};

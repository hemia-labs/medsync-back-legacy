const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const SecurityConfig = require('../../config/security');

const TOKEN_VERSION = 'v2';
const SECRET_BYTES = 32;
const TOKEN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function base64Url(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function hashRefreshToken(rawToken) {
    return crypto
        .createHmac('sha256', SecurityConfig.getRefreshTokenSecret())
        .update(String(rawToken || ''), 'utf8')
        .digest('hex');
}

function fingerprintFromHash(tokenHash) {
    return crypto
        .createHash('sha256')
        .update(String(tokenHash || ''), 'utf8')
        .digest('hex')
        .slice(0, 32);
}

function createRefreshToken(options = {}) {
    const tokenId = options.tokenId || uuidv4();
    const familyId = options.familyId || uuidv4();
    const secret = base64Url(crypto.randomBytes(SECRET_BYTES));
    const rawToken = `${TOKEN_VERSION}.${tokenId}.${secret}`;
    const tokenHash = hashRefreshToken(rawToken);

    return {
        rawToken,
        tokenId,
        familyId,
        tokenHash,
        tokenFingerprint: fingerprintFromHash(tokenHash)
    };
}

function parseRefreshToken(rawToken) {
    const parts = String(rawToken || '').split('.');

    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
        return null;
    }

    const tokenId = parts[1];
    const secret = parts[2];

    if (!TOKEN_ID_PATTERN.test(tokenId) || !secret || secret.length < 32) {
        return null;
    }

    const tokenHash = hashRefreshToken(rawToken);

    return {
        version: TOKEN_VERSION,
        tokenId,
        tokenHash,
        tokenFingerprint: fingerprintFromHash(tokenHash)
    };
}

function getExpiresAt(now = new Date()) {
    return new Date(now.getTime() + SecurityConfig.getRefreshTokenTtlMs());
}

function isExpired(expiresAt, now = new Date()) {
    return expiresAt ? new Date(expiresAt).getTime() <= now.getTime() : false;
}

module.exports = {
    TOKEN_VERSION,
    createRefreshToken,
    fingerprintFromHash,
    getExpiresAt,
    hashRefreshToken,
    isExpired,
    parseRefreshToken
};

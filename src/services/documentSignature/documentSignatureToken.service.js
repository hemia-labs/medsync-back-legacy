require('../../config/env');

const crypto = require('crypto');
const {
    SIGNATURE_REQUEST_CHANNELS
} = require('./documentSignatureRequest.constants');

const DEFAULT_QR_TTL_MINUTES = 30;
const DEFAULT_LINK_TTL_HOURS = 72;
const DEFAULT_MAX_TTL_HOURS = 168;
const TOKEN_BYTES = 32;
const MIN_SECRET_LENGTH = 32;

function toBase64Url(buffer) {
    return buffer
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function normalizeEnvironment() {
    return String(process.env.APP_ENV || process.env.ENVIRONMENT || process.env.NODE_ENV || '').toLowerCase();
}

function isTestEnvironment() {
    return normalizeEnvironment() === 'test';
}

function parsePositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.floor(parsed);
}

function getTokenSecret() {
    const secret = process.env.SIGNATURE_LINK_TOKEN_SECRET || '';
    if (!isTestEnvironment() && secret.length < MIN_SECRET_LENGTH) {
        const error = new Error('La configuracion básica del token esta incompleta.');
        error.code = 'SIGNATURE_TOKEN_SECRET_INVALID';
        throw error;
    }

    return secret || 'test-only-signature-link-token-secret';
}

function getPublicAppUrl() {
    const publicAppUrl = String(process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
    if (!publicAppUrl) {
        const error = new Error('PUBLIC_APP_URL debe estar configurado para generar links de firma.');
        error.code = 'SIGNATURE_PUBLIC_APP_URL_MISSING';
        throw error;
    }

    return publicAppUrl;
}

function resolveTtlMinutes(channel, requestedMinutes = null) {
    const maxMinutes = parsePositiveInt(
        process.env.SIGNATURE_LINK_MAX_TTL_HOURS,
        DEFAULT_MAX_TTL_HOURS
    ) * 60;

    if (requestedMinutes !== null && requestedMinutes !== undefined && requestedMinutes !== '') {
        const parsed = Number(requestedMinutes);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            const error = new Error('expires_in_minutes debe ser un numero positivo.');
            error.code = 'SIGNATURE_TTL_INVALID';
            throw error;
        }

        const minutes = Math.floor(parsed);
        if (minutes > maxMinutes) {
            const error = new Error('expires_in_minutes excede el maximo permitido.');
            error.code = 'SIGNATURE_TTL_EXCEEDS_MAX';
            throw error;
        }

        return minutes;
    }

    const defaultMinutes = channel === SIGNATURE_REQUEST_CHANNELS.QR
        ? parsePositiveInt(process.env.SIGNATURE_LINK_QR_TTL_MINUTES, DEFAULT_QR_TTL_MINUTES)
        : parsePositiveInt(process.env.SIGNATURE_LINK_DEFAULT_TTL_HOURS, DEFAULT_LINK_TTL_HOURS) * 60;

    return Math.min(defaultMinutes, maxMinutes);
}

function generateToken() {
    return toBase64Url(crypto.randomBytes(TOKEN_BYTES));
}

function hashToken(token) {
    return crypto
        .createHmac('sha256', getTokenSecret())
        .update(token)
        .digest('hex');
}

function createSignatureTokenPayload(channel, requestedMinutes = null) {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const ttlMinutes = resolveTtlMinutes(channel, requestedMinutes);
    const expiresAt = new Date(Date.now() + (ttlMinutes * 60 * 1000));

    return {
        token,
        tokenHash,
        tokenFingerprint: tokenHash.slice(-12),
        publicUrl: `${getPublicAppUrl()}/sign/d/${encodeURIComponent(token)}`,
        expiresAt,
        ttlMinutes
    };
}

module.exports = {
    toBase64Url,
    resolveTtlMinutes,
    createSignatureTokenPayload,
    hashToken
};

const SENSITIVE_KEYS = [
    'password',
    'pwd',
    'otp',
    'code',
    'token',
    'access_token',
    'refresh_token',
    'id_refresh_token',
    'authorization',
    'secret',
    'secretkey',
    'signature'
];
const SAFE_FINGERPRINT_KEYS = [
    'token_fingerprint',
    'refresh_token_fingerprint',
    'code_fingerprint',
    'password_reset_code_fingerprint',
    'email_fingerprint',
    'destination_email_fingerprint'
];

function isSensitiveKey(key) {
    const normalized = String(key || '').toLowerCase();
    if (SAFE_FINGERPRINT_KEYS.includes(normalized)) {
        return false;
    }

    return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive));
}

function sanitizeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') {
        return {};
    }

    return Object.keys(metadata).reduce((safe, key) => {
        if (isSensitiveKey(key)) {
            safe[key] = '[redacted]';
            return safe;
        }

        const value = metadata[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            safe[key] = sanitizeMetadata(value);
            return safe;
        }

        safe[key] = value;
        return safe;
    }, {});
}

function getClientIp(req) {
    return req.ip ||
        (req.socket && req.socket.remoteAddress) ||
        (req.connection && req.connection.remoteAddress) ||
        'unknown';
}

function record(event, req, metadata = {}) {
    const entry = {
        event,
        ip: getClientIp(req),
        user_agent: req && req.get ? req.get('user-agent') : null,
        path: req ? req.originalUrl || req.url : null,
        method: req ? req.method : null,
        metadata: sanitizeMetadata(metadata),
        created_at: new Date().toISOString()
    };

    console.info(`[SECURITY EVENT] ${JSON.stringify(entry)}`);
}

module.exports = {
    record,
    sanitizeMetadata
};

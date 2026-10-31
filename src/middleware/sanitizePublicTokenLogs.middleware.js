const PUBLIC_SIGNATURE_TOKEN_PATTERNS = [
    /(\/api\/public\/document-signature\/)[A-Za-z0-9_-]+/g,
    /(\/sign\/d\/)[A-Za-z0-9_-]+/g
];

function sanitizePublicSignatureToken(value) {
    return PUBLIC_SIGNATURE_TOKEN_PATTERNS.reduce(
        (current, pattern) => current.replace(pattern, '$1[redacted]'),
        String(value || '').replace(/(\/api\/platform-auth\/callback)\?[^\s]*/g, '$1?[redacted]')
    );
}

function sanitizePublicTokenLogs(req, res, next) {
    req.sanitizedUrlForLogs = sanitizePublicSignatureToken(req.originalUrl || req.url || '');
    next();
}

module.exports = sanitizePublicTokenLogs;
module.exports.sanitizePublicSignatureToken = sanitizePublicSignatureToken;

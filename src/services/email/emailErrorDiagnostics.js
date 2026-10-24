'use strict';

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(password|passwd|pass|secret|token|authorization|otp|verification[ _-]?code)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

function sanitizeDiagnosticText(value) {
    return String(value || '')
        .replace(EMAIL_PATTERN, '[redacted-email]')
        .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-aws-key]')
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(SECRET_ASSIGNMENT_PATTERN, '$1$2[redacted]')
        .replace(/\b\d{6}\b/g, '[redacted-code]');
}

function describeEmailError(error) {
    const details = error && typeof error === 'object' ? error : {};
    const stack = typeof details.stack === 'string'
        ? sanitizeDiagnosticText(details.stack).split('\n').slice(0, 32).join('\n').slice(0, 12000)
        : null;

    return {
        name: String(details.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error',
        code: String(details.code || details.Code || 'EMAIL_SEND_FAILED').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80),
        message: sanitizeDiagnosticText(details.message).slice(0, 1000) || null,
        stack
    };
}

function logEmailError(error, context = {}) {
    const entry = {
        provider: String(context.provider || 'unknown').slice(0, 32),
        type: String(context.type || 'unknown').slice(0, 64),
        ...describeEmailError(error)
    };
    console.error(`[EMAIL DELIVERY ERROR] ${JSON.stringify(entry)}`);
}

module.exports = { describeEmailError, logEmailError, sanitizeDiagnosticText };

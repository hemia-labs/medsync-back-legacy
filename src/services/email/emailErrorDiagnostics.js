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
    // SDK messages/stacks can embed links, codes and credentials without labels.
    const allowed = new Set(['MessageRejected','ThrottlingException','TooManyRequestsException',
        'MailFromDomainNotVerifiedException','NotFoundException','BadRequestException',
        'AccountSuspendedException','SendingPausedException','AccessDeniedException',
        'CredentialsProviderError','TimeoutError','EAUTH','ECONNECTION','ETIMEDOUT','ESOCKET']);
    const name = allowed.has(error && error.name) ? error.name : 'EmailDeliveryError';
    const code = allowed.has(error && error.code) ? error.code : name;
    return { name, code };
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

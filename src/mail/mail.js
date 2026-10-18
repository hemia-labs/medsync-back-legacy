'use strict';

const EmailService = require('../services/email/email.service');
const normalizeEmailResult = result => ({ process: Boolean(result && result.success) });

// Compatibility entry point; SES deliberately rejects untyped generic messages.
async function SendMail(to, mensaje, subject = 'Envio de correo', text = '') {
    return normalizeEmailResult(await EmailService.sendTransactionalEmail({ to, subject, html: mensaje, text }));
}

async function SendPasswordResetCode(to, { code, ttlMinutes } = {}) {
    return normalizeEmailResult(await EmailService.sendTransactionalEmail({ type: 'password-reset-code', to, variables: { code, ttlMinutes } }));
}

async function SendPasswordChanged(to) {
    return normalizeEmailResult(await EmailService.sendTransactionalEmail({ type: 'password-changed', to, variables: {} }));
}

module.exports = { SendMail, SendPasswordChanged, SendPasswordResetCode };

'use strict';

// Explicit opt-in only. Uses synthetic content and never changes accounts/DB.
require('../../src/config/env');
const EmailService = require('../../src/services/email/email.service');
const safeReason = error => ['AccessDeniedException', 'NotFoundException', 'UnrecognizedClientException',
    'MailFromDomainNotVerifiedException', 'MessageRejected', 'BadRequestException', 'TooManyRequestsException',
    'SendingPausedException', 'AccountSuspendedException', 'TimeoutError'].includes(error && error.name)
    ? error.name : 'SES_REQUEST_FAILED';
function safeRejection(error, recipient) {
    const message = String(error && error.message || '');
    if (/email address is not verified/i.test(message)) return {
        cause: 'IDENTITY_NOT_VERIFIED',
        recipientMentioned: message.toLowerCase().includes(recipient.toLowerCase()),
        authSenderMentioned: message.includes(process.env.EMAIL_FROM_AUTH),
        notificationSenderMentioned: message.includes(process.env.EMAIL_FROM_NOTIFICATIONS)
    };
    return { cause: safeReason(error) };
}

async function main() {
    if (!process.argv.includes('--send-to-authorized-recipient') || process.env.ALLOW_QA_SES_EMAIL_SEND !== 'YES') {
        console.log('No email sent. Requires --send-to-authorized-recipient, ALLOW_QA_SES_EMAIL_SEND=YES and QA_SES_EMAIL_TO for an explicitly authorized test recipient.');
        return;
    }
    const to = String(process.env.QA_SES_EMAIL_TO || '').trim();
    if (!/^[^\s@<>";,]+@[^\s@<>";,]+\.[^\s@<>";,]+$/.test(to) || /[\x00-\x1f\x7f]/.test(to)) throw new Error('QA_RECIPIENT_REQUIRED');
    const ready = EmailService.initialize();
    if (EmailService.providerName() !== 'ses' || !ready.success) throw new Error('SES_CONFIG_REQUIRED');
    const provider = EmailService.provider();
    const originalSend = provider.client.send.bind(provider.client);
    let failureReason = null;
    let rejection = null;
    // Observe only a safe error name; SDK messages may contain private values.
    provider.client.send = async command => {
        try { return await originalSend(command); }
        catch (error) { failureReason = safeReason(error); rejection = safeRejection(error, to); throw error; }
    };
    const cases = [
        { type: 'password-reset-code', variables: { code: '048291', ttlMinutes: 10 } },
        { type: 'document-signature', variables: {
            patientName: 'Prueba técnica sin paciente real', clinicName: 'MedSync - Prueba técnica', clinicLogoUrl: '',
            documentTitle: 'Prueba de correo: no es un documento para firmar', doctorName: '',
            expiresAt: 'Sin vigencia: prueba técnica sin documento real', publicUrl: 'https://example.invalid/medsync/prueba-correo'
        } }
    ];
    const checks = [];
    try {
        for (const test of cases) {
            failureReason = null;
            rejection = null;
            const result = await EmailService.sendTransactionalEmail({ ...test, to });
            checks.push({ type: test.type, accepted: Boolean(result.success), messageId: result.messageId || null,
                code: result.code || null, reason: failureReason, rejection });
        }
    } finally { provider.client.destroy(); }
    console.log(JSON.stringify({ checks, accountOrDocumentChanges: false, recipientLogged: false, deliveryConfirmed: false }, null, 2));
    if (checks.some(check => !check.accepted)) process.exitCode = 1;
}
main().catch(() => { console.error('SES send verification unavailable. Check explicit authorization and configuration; no private values are logged.'); process.exitCode = 1; });

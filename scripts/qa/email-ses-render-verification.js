'use strict';

// Optional read-only AWS check. This script cannot send email or change SES.
require('../../src/config/env');
const { SESv2Client, TestRenderEmailTemplateCommand } = require('@aws-sdk/client-sesv2');
const EmailService = require('../../src/services/email/email.service');
async function main() {
    if (!process.argv.includes('--aws-render')) {
        console.log('Use --aws-render to check the four published templates with synthetic variables. No email is sent.');
        return;
    }
    const ready = EmailService.initialize();
    if (EmailService.providerName() !== 'ses' || !ready.success) throw new Error('EMAIL_SES_CONFIG_NOT_READY');
    const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(), secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim() };
    if (process.env.AWS_SESSION_TOKEN) credentials.sessionToken = process.env.AWS_SESSION_TOKEN.trim();
    const client = new SESv2Client({ region: process.env.AWS_REGION.trim(), credentials, maxAttempts: 1,
        requestHandler: { connectionTimeout: 5000, requestTimeout: 15000, throwOnRequestTimeout: true } });
    const signature = { patientName: 'QA Synthetic', clinicName: 'QA Clinic', clinicLogoUrl: '', documentTitle: 'QA Document',
        doctorName: '', expiresAt: '20 de octubre de 2026, 18:00 (CDMX)', publicUrl: 'https://example.invalid/firma/qa-render' };
    const changed = { accountEmail: 'qa@example.invalid', changedAtLabel: '29 oct 2026, 10:30 h (Ciudad de México)',
        changeOrigin: 'Recuperación de contraseña', sessionNotice: 'Todas las sesiones se cerraron. Inicia sesión con tu nueva contraseña.',
        supportUrl: 'mailto:qa%40example.invalid' };
    const cases = [
        [process.env.EMAIL_PASSWORD_CHANGE_CODE_TEMPLATE, { code: '059173', ttlMinutes: 10, html: { code: '059173', ttlMinutes: '10' } }],
        [process.env.EMAIL_PASSWORD_CHANGED_TEMPLATE, { ...changed, html: { ...changed } }],
        [process.env.EMAIL_PASSWORD_RESET_TEMPLATE, { code: '048291', ttlMinutes: 10, html: { code: '048291', ttlMinutes: '10' } }],
        [process.env.EMAIL_DOCUMENT_SIGNATURE_TEMPLATE, { ...signature, html: { ...signature } }]
    ];
    const checks = [];
    try {
        for (const [template, data] of cases) {
            try {
                const result = await client.send(new TestRenderEmailTemplateCommand({ TemplateName: template, TemplateData: JSON.stringify(data) }));
                checks.push({ template, rendered: Boolean(result.RenderedTemplate), code: null });
            } catch (error) {
                const safeCodes = ['AccessDeniedException', 'NotFoundException', 'BadRequestException', 'UnrecognizedClientException', 'InvalidClientTokenId', 'ExpiredTokenException', 'TimeoutError'];
                checks.push({ template, rendered: false, code: safeCodes.includes(error.name) ? error.name : 'AWS_RENDER_CHECK_FAILED' });
            }
        }
    } finally { client.destroy(); }
    console.log(JSON.stringify({ checks, emailSent: false }, null, 2));
    if (checks.some(check => !check.rendered)) process.exitCode = 1;
}
main().catch(() => { console.error('SES render check unavailable. Verify local SES configuration; no email was sent.'); process.exitCode = 1; });

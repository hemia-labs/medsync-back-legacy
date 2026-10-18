'use strict';

// Local configuration only: no AWS calls, delivery, DB access or secret output.
require('../../src/config/env');
const EmailService = require('../../src/services/email/email.service');
const names = ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'EMAIL_FROM_NAME', 'EMAIL_FROM_AUTH',
    'EMAIL_FROM_NOTIFICATIONS', 'EMAIL_REPLY_TO', 'EMAIL_CONFIGURATION_SET_AUTH', 'EMAIL_CONFIGURATION_SET_TRANSACTIONAL',
    'EMAIL_PASSWORD_RESET_TEMPLATE', 'EMAIL_PASSWORD_CHANGED_TEMPLATE', 'EMAIL_DOCUMENT_SIGNATURE_TEMPLATE'];
const provider = EmailService.providerName();
const missing = names.filter(name => !String(process.env[name] || '').trim());
const initialized = provider === 'ses' ? EmailService.initialize() : { success: false, code: 'EMAIL_SES_NOT_SELECTED' };
let signatureLinksHttps = false;
try {
    const url = new URL(process.env.PUBLIC_APP_URL);
    signatureLinksHttps = url.protocol === 'https:' && !url.username && !url.password;
} catch (_) { /* Report readiness only, never print a configured URL/token. */ }
const report = {
    provider, configurationReady: initialized.success,
    missing, code: initialized.code || null,
    temporarySessionConfigured: Boolean(process.env.AWS_SESSION_TOKEN),
    signatureLinksHttps,
    awsAccess: 'NOT_CHECKED', templatesPublished: 'NOT_CHECKED', delivery: 'NOT_TESTED'
};
console.log(JSON.stringify(report, null, 2));
if (!report.configurationReady) process.exitCode = 1;

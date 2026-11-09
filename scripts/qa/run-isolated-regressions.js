'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Reviewed allowlist only. Never discover fixtures/live MySQL scripts by glob.
const tests = [
    'platform-sso.test', 's18-session-revocation-http-regression',
    'account-legal-regression',
    'registration-recovery-regression',
    'registration-plans-regression',
    'private-images-regression',
    'po18-security-regression', 'request-body-security-regression',
    'issues-hardening-regression', 'issues-upload-regression', 'deploy-release-regression',
    'prescription-issue-regression', 'prescription-output-regression',
    'prescription-filter-validation-regression', 's19-prescription-save-regression',
    'email-document-dispatch-regression', 'po13-image-upload-regression',
    'ses-email-provider-regression', 's16-patient-safety-regression',
    's16-history-integrity-regression', 's19-history-finalize-authorization-regression',
    'allergy-status-regression', 'clinical-history-usability-regression',
    'clinical-template-permission-status-regression', 'ux13-professional-phone-regression',
    'document-html-security-regression', 'co11-professional-domain-regression',
    'co25-csrf-regression', 'co25-csrf-http-regression', 'co25-a2-policy-regression'
];
for (const test of tests) {
    console.log(`TEST ${test}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, test + '.js')], { stdio: 'inherit', timeout: 60000 });
    if (result.status !== 0) { process.exitCode = 1; break; }
}

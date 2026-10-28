'use strict';
// Real sendEmail orchestration and audit/failure SQL helpers. Creation/context
// and delivery are in-memory stubs: no DB, network, real links or messages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
function stub(modulePath, exports) {
    const id = require.resolve(modulePath);
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const originalProvider = process.env.EMAIL_PROVIDER;
const sent = [], events = [], statuses = new Map();
const recovery = [];
stub('../../src/services/recoveryJournal', { async recordSignatureEmailAudit(record) { recovery.push(record); } });
let createCount = 0, allowed = true, contextAvailable = true, auditFails = false;
let delivery = { success: true, provider: 'ses', messageId: 'qa-message-id' };
stub('../../src/config/env', {});
stub('../../src/db/Sequelize.connection', { async query(sql, options) {
    const data = options.replacements;
    assert.equal(data._id_business, 'qa-tenant', 'Every audit/failure update stays tenant scoped');
    if(sql.includes('UPDATE document_signature_requests')) {
        statuses.set(data._id_document_signature_request, data._failed_status);
        return [1];
    }
    if(sql.includes('INSERT INTO patient_document_events')) {
        if (auditFails && data._event_type === 'SIGNATURE_LINK_SEND_EMAIL_SUCCESS') throw Error('Synthetic post-delivery audit outage');
        events.push({ event: data._event_type, ...JSON.parse(data._notes) });
        return [];
    }
    throw new Error('Unexpected query in delivery-only regression');
} });
stub('../../src/services/email/email.service', { async sendTransactionalEmail(message) {
    sent.push(JSON.parse(JSON.stringify(message)));
    if(delivery instanceof Error) throw delivery;
    return delivery;
} });
stub('../../src/services/email/templates/documentSignatureEmail.template', () => { throw Error('DAO must not render email'); });
const dao = require('../../src/Dao/mysql/documentSignatureRequest.dao');
const expiresAt = '2026-10-17T15:30:00.000Z';
const dummyUrl = 'https://example.invalid/sign/d/qa-disposable-link';
dao.create = async body => {
    assert.equal(body.id_business, 'qa-tenant');
    assert.equal(body.id_patient_document, 'qa-document');
    assert.equal(body.channel, 'email');
    assert.equal(body.recipient_email, 'qa-recipient@example.invalid');
    assert.equal(body.recipient_phone, null);
    assert.equal(body.expires_in_minutes, null, 'Delivery preserves server-owned expiry');
    if(!allowed) return { status: 403, success: false, data: null, message: 'No tienes permiso.' };
    const id = 'qa-request-' + ++createCount;
    statuses.set(id, 'pending');
    return { success: true, data: { id_document_signature_request: id, id_patient_document: 'qa-document',
        signature_role: 'PATIENT', expires_at: expiresAt, public_url: dummyUrl, token_fingerprint: 'qa-fingerprint' } };
};
dao.getEmailContext = async (tenant, document) => {
    assert.equal(tenant, 'qa-tenant'); assert.equal(document, 'qa-document');
    return contextAvailable ? { id_business: tenant, id_patient_document: document,
        patient_name: 'Paciente', patient_surname: 'QA', business_legal_name: 'Clínica QA',
        business_name: 'Nombre comercial QA', business_logo_url: 'https://example.invalid/logo.png',
        title: 'Consentimiento QA', document_type: 'TREATMENT_PLAN_CONSENT', doctor_name_snapshot: 'Doctor QA' } : null;
};
const body = { id_business: 'qa-tenant', id_login: 'qa-actor', id_patient_document: 'qa-document',
    signature_role: 'PATIENT', recipient_email: '  QA-Recipient@Example.Invalid  ' };
(async () => {
    process.env.EMAIL_PROVIDER = ' SES ';
    let response = await dao.sendEmail(body);
    assert.equal(response.success, true); assert.equal(response.data.email_sent, true);
    assert.equal(response.data.expires_at, expiresAt); assert.equal(response.data.channel, 'email');
    assert.deepEqual(Object.keys(sent[0]).sort(), ['to', 'type', 'variables']);
    assert.equal(sent[0].type, 'document-signature'); assert.equal(sent[0].to, 'qa-recipient@example.invalid');
    assert.deepEqual(Object.keys(sent[0].variables).sort(), ['clinicLogoUrl', 'clinicName', 'doctorName', 'documentTitle', 'expiresAt', 'patientName', 'publicUrl']);
    assert.deepEqual({ ...sent[0].variables, expiresAt: null }, {
        patientName: 'Paciente QA', clinicName: 'Clínica QA', clinicLogoUrl: 'https://example.invalid/logo.png',
        documentTitle: 'Consentimiento QA', doctorName: 'Doctor QA', expiresAt: null, publicUrl: dummyUrl
    });
    assert.match(sent[0].variables.expiresAt, /9:30/, 'Expiry is formatted in Mexico City time, not raw UTC');
    assert.notEqual(sent[0].variables.expiresAt, expiresAt);
    assert.equal(events.at(-2).metadata.provider, 'ses'); assert.equal(events.at(-1).metadata.provider, 'ses');
    assert.equal(events.at(-1).metadata.message_id, 'qa-message-id');
    assert.equal(events.at(-1).metadata.recipient_email_masked, 'q***@example.invalid');
    assert.doesNotMatch(JSON.stringify(events), /\/sign\/d\/|qa-disposable-link|QA-Recipient|data:image/, 'Audit never contains public bearer URL, original recipient or signature images');
    const source = fs.readFileSync(require.resolve('../../src/Dao/mysql/documentSignatureRequest.dao'), 'utf8');
    assert.doesNotMatch(source, /documentSignatureEmailTemplate/, 'Rendering belongs only to the email service');

    auditFails = true;
    const accepted = await dao.sendEmail(body);
    assert.equal(accepted.success, true);
    assert.equal(accepted.data.email_sent, true);
    assert.equal(statuses.get(accepted.data.id_document_signature_request), 'pending', 'Accepted delivery survives a failed success audit');
    assert.equal(recovery[0].requestId, accepted.data.id_document_signature_request);
    assert.equal(recovery[0].messageId, 'qa-message-id');
    assert.doesNotMatch(JSON.stringify(recovery), /\/sign\/d\/|qa-recipient|qa-disposable-link/);
    auditFails = false;
    delivery = { success: false, provider: 'ses', code: 'EMAIL_SES_REJECTED', message: 'Sensitive provider detail' };
    response = await dao.sendEmail(body);
    const failedRequest = 'qa-request-' + createCount;
    assert.equal(response.status, 502); assert.equal(response.code, 'SIGNATURE_EMAIL_SEND_FAILED');
    assert.equal(statuses.get(failedRequest), 'failed');
    assert.equal(events.at(-1).event, 'SIGNATURE_LINK_SEND_EMAIL_FAILED');
    assert.equal(events.at(-1).metadata.provider, 'ses'); assert.equal(events.at(-1).metadata.error_code, 'EMAIL_SES_REJECTED');
    assert.doesNotMatch(JSON.stringify(response), /Sensitive provider detail|qa-disposable-link/);
    delivery = { success: true, provider: 'ses', messageId: 'qa-retry-message' };
    response = await dao.sendEmail(body);
    assert.equal(response.success, true); assert.equal(statuses.get(failedRequest), 'failed');
    assert.notEqual(response.data.id_document_signature_request, failedRequest);
    assert.equal(statuses.get(response.data.id_document_signature_request), 'pending', 'An explicit retry creates a pending request without reviving failed links');

    delivery = Object.assign(new Error('Sensitive provider exception'), { code: 'EMAIL_SES_THROW' });
    response = await dao.sendEmail(body);
    assert.equal(response.status, 502); assert.equal(statuses.get('qa-request-' + createCount), 'failed');
    assert.equal(events.at(-1).metadata.provider, 'ses'); assert.equal(events.at(-1).metadata.error_code, 'EMAIL_SES_THROW');
    assert.doesNotMatch(JSON.stringify(response), /Sensitive provider exception/);

    contextAvailable = false; const beforeContext = sent.length;
    response = await dao.sendEmail(body);
    assert.equal(response.code, 'SIGNATURE_EMAIL_CONTEXT_NOT_FOUND');
    assert.equal(statuses.get('qa-request-' + createCount), 'failed'); assert.equal(sent.length, beforeContext);
    contextAvailable = true; allowed = false; const beforeDenial = sent.length;
    assert.equal((await dao.sendEmail(body)).status, 403); assert.equal(sent.length, beforeDenial, 'Permission denial never dispatches');
    assert.equal((await dao.sendEmail({ ...body, recipient_email: 'invalid' })).status, 400); assert.equal(sent.length, beforeDenial);

    allowed = true; delete process.env.EMAIL_PROVIDER; delivery = { success: true, messageId: 'qa-default-provider' };
    await dao.sendEmail(body);
    assert.equal(events.at(-2).metadata.provider, 'smtp'); assert.equal(events.at(-1).metadata.provider, 'smtp', 'Mocks without provider metadata use normalized configured/default provider');
    console.log('PASS document email dispatch: typed seven-variable contract, central rendering, timezone/expiry, provider metadata, masked audit, failed status, explicit retry, safe provider errors, missing context and denied/invalid no-send. Stubbed creation/context/delivery; no DB or network.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    if(originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalProvider;
});

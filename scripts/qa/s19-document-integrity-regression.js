// Real document/signing DAOs, transactional in-memory SQL adapter; no DB or deliveries.
const assert = require('node:assert/strict');
const stub = (path, value) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports: value }; };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=';
const flags = { requires_patient_signature: 1, requires_tutor_signature: 0, requires_doctor_signature: 1, requires_witness1_signature: 0, requires_witness2_signature: 0 };
let state, queries, failEvent, failVersion;
const document = () => ({ ...state.document, ...state.flags });
stub('../../src/db/Sequelize.connection', {
    async transaction() { const saved = structuredClone(state); return { finished: false, async commit() { this.finished = 'commit'; }, async rollback() { state = saved; this.finished = 'rollback'; } }; },
    async query(sql, options = {}) {
        const r = options.replacements || {}; queries.push({ sql, options });
        if (sql.includes('INSERT INTO patient_documents')) { state.document = Object.fromEntries(Object.entries(r).map(([k, v]) => [k.slice(1), v])); return []; }
        if (sql.includes('INSERT INTO patient_document_events')) {
            if (failEvent) throw new Error('Injected audit failure');
            state.events.push({ id_patient_document: r._id_patient_document, event_type: r._event_type, notes: r._notes }); return [];
        }
        if (/FROM patient_document_events/.test(sql)) return state.events.filter(e => e.event_type === 'SIGNATURE_REQUIREMENTS_SNAPSHOT');
        if (sql.includes('UPDATE document_templates')) { state.flags = Object.fromEntries(Object.keys(flags).map(key => [key, r[`_${key}`]])); return []; }
        if (sql.includes('UPDATE document_template_versions')) return [];
        if (sql.includes('INSERT INTO document_template_versions')) { if (failVersion) throw new Error('Injected template-version failure'); state.template.version_number = r._version_number; state.template.content_html = r._content_html; return []; }
        if (sql.includes('MAX(version_number)')) return [{ next_version: state.template.version_number + 1 }];
        if (sql.includes('FROM document_templates')) return [{ ...state.template, ...state.flags }];
        if (sql.includes('FROM patient_documents')) {
            if (sql.includes("status IN ('BORRADOR', 'PENDIENTE_FIRMA')")) return state.document ? [document()] : [];
            if (sql.includes("status = 'FIRMADO'")) return state.document && state.document.status === 'FIRMADO' ? [document()] : [];
            return state.document ? [document()] : [];
        }
        if (sql.includes('FROM patient_document_signatures')) return structuredClone(state.signatures);
        if (sql.includes('INSERT INTO patient_document_signatures')) { state.signatures.push({ id_patient_document: r._id_patient_document, signature_role: r._signature_role, signature_image: r._signature_image, signed_at: new Date() }); return []; }
        if (sql.includes('UPDATE patient_documents')) { state.document.status = r._status; if (r._status === 'FIRMADO') state.document.signed_content_html_snapshot = state.document.content_html_snapshot; return []; }
        if (sql.includes('FROM person')) return [{ id_person: 'qa-patient', id_business: 'qa-tenant', name: 'QA', surname: 'Patient' }];
        if (sql.includes('FROM business')) return [{ name: 'QA Professional' }];
        if (sql.includes('FROM document_signature_requests')) return [{ ...state.request }];
        if (sql.includes('UPDATE document_signature_requests')) { state.request.status = r._signed_status || r._opened_status || 'revoked'; return []; }
        throw new Error(`Unhandled SQL: ${sql.slice(0, 100)}`);
    }
});
stub('../../src/services/email/email.service', new Proxy({}, { get() { throw new Error('External delivery forbidden'); } }));
const dao = require('../../src/Dao/mysql/document.dao');
const publicDao = require('../../src/Dao/mysql/publicDocumentSignature.dao');
const requestDao = require('../../src/Dao/mysql/documentSignatureRequest.dao');
dao.hasPermission = async () => true;
dao.enforceTemplateLicensing = async () => null;
dao.listTemplates = async () => ({ status: 200, data: [{ ...state.template, ...state.flags }] });
dao.resolveDoctor = async () => ({ profile: { id_login: 'qa-doctor', id_doctor_professional_profile: 'qa-profile', professional_name: 'QA Doctor', professional_license: 'DUMMY', signature_image: png } });
const body = { id_business: 'qa-tenant', id_person: 'qa-patient', id_login: 'qa-doctor', id_document_template: 'qa-template', responsible_doctor_user_id: 'qa-doctor' };
function reset(withDocument = true) {
    queries = []; failEvent = false; failVersion = false;
    state = { flags: { ...flags }, events: [], signatures: [], template: { id_document_template: 'qa-template', id_document_template_version: 'qa-v1', version_number: 1, template_type: 'SENSITIVE_DATA_CONSENT', name: 'Consent dummy', content_html: '<p>Consent for {{nombrePaciente}}</p>' },
        document: withDocument ? { id_patient_document: 'qa-document', id_business: 'qa-tenant', id_person: 'qa-patient', status: 'PENDIENTE_FIRMA', document_type: 'SENSITIVE_DATA_CONSENT', responsible_doctor_user_id: 'qa-doctor', doctor_signature_snapshot: png, content_html_snapshot: '<p>Original</p>' } : null,
        request: { id_document_signature_request: 'qa-request', id_patient_document: 'qa-document', id_person: 'qa-patient', id_business: 'qa-tenant', document_type: 'SENSITIVE_DATA_CONSENT', signature_role: 'PATIENT', status: 'pending', expires_at: new Date(Date.now() + 3600000), channel: 'qr' } };
}
const sign = extra => dao.updateStatus({ ...body, id_patient_document: state.document.id_patient_document, ...extra }, 'FIRMADO', 'SIGNED', 'Signed dummy');
(async () => {
    reset(); failVersion = true;
    assert.equal((await dao.saveTemplate({ ...body, name: 'Changed template', requires_patient_signature: false, content_html: '<p>Changed content</p>' })).status, 500);
    assert.equal(state.flags.requires_patient_signature, 1, 'Failed version write must roll back template flags');
    assert.equal(state.template.version_number, 1);
    reset(); assert.equal((await dao.saveTemplate({ ...body, name: 'Changed template', requires_patient_signature: false, content_html: '<p>Changed content</p>' })).status, 200);
    assert.equal(state.flags.requires_patient_signature, 0); assert.equal(state.template.version_number, 2);
    assert.ok(queries.some(q => /FROM document_templates/.test(q.sql) && /FOR UPDATE/.test(q.sql)));
    assert.ok(queries.filter(q => /^\s*(?:INSERT|UPDATE)/.test(q.sql)).every(q => q.options.transaction));
    reset(); assert.equal((await sign({})).status, 400, 'Document cannot be marked signed without a required signature');
    assert.equal(state.document.status, 'PENDIENTE_FIRMA');
    reset(); assert.equal((await sign({ patient_signature: png, signature_role: 'WITNESS2' })).status, 400, 'Only required roles may be captured');
    reset(); assert.equal((await sign({ patient_signature: 'not-a-signature' })).status, 400);
    reset(); failEvent = true; assert.equal((await sign({ patient_signature: png })).status, 500);
    assert.equal(state.document.status, 'PENDIENTE_FIRMA'); assert.equal(state.signatures.length, 0, 'Audit failure rolls back signature and state');
    reset(); assert.equal((await sign({ patient_signature: png })).status, 200); assert.equal(state.document.status, 'FIRMADO');
    assert.equal(state.signatures.length, 1); assert.equal(state.request.status, 'revoked');
    assert.equal((await sign({ patient_signature: png })).status, 400); assert.equal(state.signatures.length, 1, 'Retry cannot duplicate a completed signature');
    assert.ok(queries.some(q => /FROM patient_documents/.test(q.sql) && /FOR UPDATE/.test(q.sql)));
    assert.ok(queries.filter(q => /INSERT|UPDATE/.test(q.sql) && !q.sql.startsWith('SELECT')).every(q => q.options.transaction));
    reset(false); assert.equal((await dao.createDocument({ ...body, status: 'FIRMADO' })).status, 400); assert.equal(state.document, null);
    reset(false); assert.equal((await dao.createDocument({ ...body, status: 'PENDIENTE_FIRMA' })).status, 200);
    const id = state.document.id_patient_document;
    assert.equal(state.events.filter(e => e.event_type === 'SIGNATURE_REQUIREMENTS_SNAPSHOT').length, 1);
    assert.ok(queries.filter(q => q.sql.includes('INSERT INTO')).every(q => q.options.transaction));
    state.flags = { ...flags, requires_patient_signature: 0, requires_tutor_signature: 1, requires_witness1_signature: 1 };
    const listed = await dao.listPatientDocuments(body); assert.equal(listed.data[0].requires_patient_signature, 1); assert.equal(listed.data[0].requires_tutor_signature, 0);
    const requested = await requestDao.getDocumentForRequest(body.id_business, id); assert.deepEqual(requestDao.requiredSignatureRoles(requested), ['PATIENT', 'DOCTOR']);
    state.request.id_patient_document = id;
    const token = 'a'.repeat(43);
    const opened = await publicDao.openByToken(token); assert.equal(opened.status, 200); assert.equal(opened.data.document.content_html_snapshot, '<p>Consent for QA Patient</p>');
    const signed = await publicDao.signByToken(token, { accepted_electronic_signature: true, signature_image: png });
    assert.equal(signed.status, 200); assert.equal(state.document.status, 'FIRMADO', 'Changed live flags cannot change a prepared document');
    reset(false); failEvent = true; assert.equal((await dao.createDocument(body)).status, 500); assert.equal(state.document, null, 'Snapshot failure rolls back created document');
    reset(); state.events = [{ id_patient_document: 'qa-document', event_type: 'SIGNATURE_REQUIREMENTS_SNAPSHOT', notes: '{broken' }];
    assert.equal((await sign({ patient_signature: png })).status, 500); assert.equal(state.signatures.length, 0, 'Malformed snapshot must never fall back to current template');
    state.request.status = 'revoked';
    assert.equal((await publicDao.openByToken(token)).code, 'SIGNATURE_LINK_NOT_AVAILABLE', 'Unavailable links do not load document metadata');
    state.request.status = 'pending'; state.request.expires_at = new Date(Date.now() - 60000);
    assert.equal((await publicDao.signByToken(token, { accepted_electronic_signature: true, signature_image: png })).code, 'SIGNATURE_LINK_NOT_AVAILABLE');
    console.log('PASS S19 document integrity: missing/invalid/unrequired signature rejection; atomic local signing/creation; lock, revocation, server snapshot, template drift ignored across list/request/public signing, and malformed snapshot fails closed. Real DAOs; in-memory SQL; no DB or deliveries.');
})().catch(error => { console.error(error); process.exitCode = 1; });

// One connection; synthetic Professional tenant only; all inserts/changes rolled
// back. Real document/request/public DAOs and SQL; email always blocked.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const crypto = require('node:crypto');
const { v4: uuid } = require('uuid');
const { injectReplacements } = require('sequelize/lib/utils/sql');
const config = require('../../src/config/config');
const dialect = { name: 'mysql', TICK_CHAR_LEFT: '`', TICK_CHAR_RIGHT: '`', canBackslashEscape: () => true, supports: {} };
const originalEnv = { PUBLIC_APP_URL: process.env.PUBLIC_APP_URL, SIGNATURE_LINK_TOKEN_SECRET: process.env.SIGNATURE_LINK_TOKEN_SECRET };
process.env.PUBLIC_APP_URL = 'https://synthetic-signing.invalid';
process.env.SIGNATURE_LINK_TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
const stub = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=';
(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    let serial = 0, mailAttempts = 0, failTemplateVersion = false;
    stub('../../src/db/Sequelize.connection', {
        async transaction() {
            const name = `s19_doc_${++serial}`; await connection.query(`SAVEPOINT ${name}`);
            return { finished: false, async commit() { if (!this.finished) { await connection.query(`RELEASE SAVEPOINT ${name}`); this.finished = 'commit'; } },
                async rollback() { if (!this.finished) { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); this.finished = 'rollback'; } } };
        },
        async query(sql, options = {}) {
            assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|\bCALL\b|\bALTER\b|\bDROP\b/i);
            if (failTemplateVersion && sql.includes('INSERT INTO document_template_versions')) throw new Error('S19 injected template-version failure');
            const [rows] = await connection.query(injectReplacements(sql, dialect, options.replacements)); return rows;
        }
    });
    stub('../../src/services/email/email.service', new Proxy({}, { get: () => async () => { mailAttempts++; throw Error('No deliveries in S19 QA'); } }));
    const documents = require('../../src/Dao/mysql/document.dao');
    const requests = require('../../src/Dao/mysql/documentSignatureRequest.dao');
    const publicSign = require('../../src/Dao/mysql/publicDocumentSignature.dao');
    const business = uuid(), patient = uuid(), actor = uuid(), profile = uuid(), role = uuid(), template = uuid(), version = uuid();
    const body = { id_business: business, id_person: patient, id_login: actor, rol: 's19_qa', id_document_template: template, responsible_doctor_user_id: actor };
    const ok = result => { assert.equal(result.status, 200, result.message); return result.data; };
    const unavailable = result => { assert.equal(result.code, 'SIGNATURE_LINK_NOT_AVAILABLE'); assert.equal(result.data, null); };
    const token = result => new URL(result.public_url).pathname.split('/').pop();
    const insert = async (table, data) => { const fields = Object.keys(data); await connection.query(`INSERT INTO \`${table}\` (${fields.map(f => `\`${f}\``).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, Object.values(data)); };
    const create = async title => {
        const list = ok(await documents.createDocument({ ...body, status: 'PENDIENTE_FIRMA', title, force_new_version: true, origin: 'CLINICAL_HISTORY' }));
        const document = list.find(row => row.title === title); assert.ok(document); return document;
    };
    const request = async document => ok(await requests.create({ ...body, id_patient_document: document.id_patient_document, signature_role: 'PATIENT', channel: 'qr', expires_in_minutes: 30 }));
    const status = async id => (await connection.query('SELECT status FROM patient_documents WHERE id_patient_document=?', [id]))[0][0].status;
    const sign = (document, extra = {}) => documents.updateStatus({ ...body, id_patient_document: document.id_patient_document, ...extra }, 'FIRMADO', 'SIGNED', 'Synthetic signing');
    try {
        await connection.beginTransaction();
        await insert('business', { id_business: business, name: 'S19 Professional ficticio', slug: `s19-${business}`, plan: 'professional', active: 1 });
        await insert('rol', { id_rol: role, code: `s19_${role}`, desc_rol: 'S19 synthetic document role', active: 1 });
        await insert('login', { id_login: actor, id_business: business, id_rol: role, name: 'S19 ficticio', active: 1 });
        const codes = ['documents.view', 'documents.create', 'documents.sign', 'documents.cancel', 'documents.signature.request', 'documents.config'];
        const [permissions] = await connection.query('SELECT id_cat_permission,code FROM cat_permission WHERE code IN (?) AND active=1 AND is_active=1', [codes]);
        assert.equal(permissions.length, codes.length);
        for (const permission of permissions) await insert('business_role_permission', { id_business: business, id_rol: role, id_cat_permission: permission.id_cat_permission, active: 1 });
        await insert('person', { id_person: patient, id_business: business, name: 'Paciente ficticio', surname: 'S19 Documentos', active: 1 });
        await insert('doctor_professional_profile', { id_doctor_professional_profile: profile, id_business: business, id_login: actor, professional_name: 'Doctor ficticio S19', professional_license: 'DUMMY-S19', signature_image: png, can_sign_documents: 1, is_active: 1 });
        await insert('document_templates', { id_document_template: template, id_business: business, name: 'S19 Consent dummy', template_type: 'SENSITIVE_DATA_CONSENT',
            requires_patient_signature: 1, requires_doctor_signature: 1, requires_tutor_signature: 0, requires_witness1_signature: 0, requires_witness2_signature: 0, is_active: 1, active: 1 });
        await insert('document_template_versions', { id_document_template_version: version, id_document_template: template, version_number: 1, content_html: '<p>Consentimiento ficticio para {{nombrePaciente}}</p>', is_current: 1, status: 'ACTIVE' });
        assert.equal((await documents.createDocument({ ...body, status: 'FIRMADO' })).status, 400);
        const remote = await create('S19 remote original');
        assert.equal(remote.requires_patient_signature, 1);
        assert.equal((await documents.createDocument(body)).status, 400, 'Duplicate pending consent blocked');
        assert.equal((await sign(remote)).status, 400, 'No fabricated signed status without patient signature');
        const changedTemplate = { ...body, template_type: 'SENSITIVE_DATA_CONSENT', name: 'S19 updated template', requires_patient_signature: false,
            requires_tutor_signature: true, requires_doctor_signature: true, requires_witness1_signature: true, content_html: '<p>New template content</p>' };
        failTemplateVersion = true;
        assert.equal((await documents.saveTemplate(changedTemplate)).status, 500);
        failTemplateVersion = false;
        const unchangedTemplate = await documents.getTemplateVersion(business, template);
        assert.equal(unchangedTemplate.requires_patient_signature, 1); assert.equal(unchangedTemplate.version_number, 1,
            'Template requirements and original current version survive a failed version write');
        ok(await documents.saveTemplate(changedTemplate));
        assert.equal((await documents.getTemplateVersion(business, template)).version_number, 2);
        const listed = ok(await documents.listPatientDocuments(body)).find(row => row.id_patient_document === remote.id_patient_document);
        assert.equal(listed.requires_patient_signature, 1); assert.equal(listed.requires_tutor_signature, 0); assert.equal(listed.requires_witness1_signature, 0);
        const first = await request(remote), old = token(first);
        assert.equal(ok(await publicSign.openByToken(old)).document.content_html_snapshot, '<p>Consentimiento ficticio para Paciente ficticio S19 Documentos</p>');
        ok(await requests.revoke({ ...body, id_document_signature_request: first.id_document_signature_request }));
        unavailable(await publicSign.openByToken(old)); unavailable(await publicSign.signByToken(old, { accepted_electronic_signature: true, signature_image: png }));
        const expired = await request(remote), expiredToken = token(expired);
        await connection.query('UPDATE document_signature_requests SET expires_at=DATE_SUB(NOW(),INTERVAL 1 DAY) WHERE id_document_signature_request=?', [expired.id_document_signature_request]);
        unavailable(await publicSign.signByToken(expiredToken, { accepted_electronic_signature: true, signature_image: png }));
        const current = await request(remote), activeToken = token(current);
        assert.equal(ok(await publicSign.signByToken(activeToken, { accepted_electronic_signature: true, signature_image: png })).document_status, 'FIRMADO');
        unavailable(await publicSign.signByToken(activeToken, { accepted_electronic_signature: true, signature_image: png }));
        assert.equal(await status(remote.id_patient_document), 'FIRMADO');
        await connection.query('UPDATE document_templates SET requires_patient_signature=1, requires_tutor_signature=0, requires_witness1_signature=0 WHERE id_document_template=?', [template]);
        const local = await create('S19 local original'), localLink = await request(local);
        assert.equal((await sign(local, { patient_signature: 'invalid' })).status, 400);
        assert.equal((await sign(local, { patient_signature: png, signature_role: 'WITNESS2' })).status, 400);
        assert.equal((await sign(local, { patient_signature: png, responsible_doctor_user_id: uuid() })).status, 400);
        await connection.query('UPDATE document_templates SET requires_patient_signature=0, requires_witness1_signature=1 WHERE id_document_template=?', [template]);
        ok(await sign(local, { patient_signature: png })); assert.equal(await status(local.id_patient_document), 'FIRMADO');
        unavailable(await publicSign.openByToken(token(localLink)));
        const [signedRows] = await connection.query('SELECT id_patient_document, COUNT(*) AS total FROM patient_document_signatures WHERE id_business=? GROUP BY id_patient_document', [business]);
        assert.equal(signedRows.length, 2); assert.ok(signedRows.every(row => row.total === 1));
        const invalid = await create('S19 invalid metadata');
        await connection.query("UPDATE patient_document_events SET notes='{bad' WHERE id_patient_document=? AND event_type='SIGNATURE_REQUIREMENTS_SNAPSHOT'", [invalid.id_patient_document]);
        assert.equal((await sign(invalid, { patient_signature: png })).status, 500);
        assert.equal(await status(invalid.id_patient_document), 'PENDIENTE_FIRMA');
        const [events] = await connection.query('SELECT event_type,notes FROM patient_document_events WHERE id_business=?', [business]);
        for (const secret of [old, expiredToken, activeToken, token(localLink)]) assert.equal(JSON.stringify(events).includes(secret), false);
        assert.equal(mailAttempts, 0);
        await connection.rollback();
        const [remaining] = await connection.query('SELECT id_business FROM business WHERE id_business=?', [business]); assert.equal(remaining.length, 0);
        console.log('PASS S19 documents: real Professional tenant/actor permissions, generated sensitive consent, atomic template update and injected version-write rollback, frozen requirements despite live-template changes, local/QR signature, expired/revoked/used links, duplicate draft prevention, invalid role/image/doctor/missing-signature rejection and malformed snapshot denial. One SQL connection; rollback verified; no external delivery.');
    } finally {
        await connection.rollback(); await connection.end();
        for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
})().catch(error => { console.error('S19 document rehearsal failed:', String(error.message).replace(/\/sign\/d\/[A-Za-z0-9_-]+/g, '/sign/d/[redacted]').replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')); process.exitCode = 1; });

// Controlled synthetic fixtures + real request/public DAOs and SQL. One connection;
// DAO transactions become savepoints inside an outer transaction always rolled back.
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
const stub = (modulePath, exports) => { const id = require.resolve(modulePath); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=';

(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    let serial = 0, mailAttempts = 0;
    stub('../../src/db/Sequelize.connection', {
        async transaction() {
            const name = `s18_sign_${++serial}`;
            await connection.query(`SAVEPOINT ${name}`);
            return { finished: false, async commit() { if (!this.finished) { await connection.query(`RELEASE SAVEPOINT ${name}`); this.finished = 'commit'; } },
                async rollback() { if (!this.finished) { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); this.finished = 'rollback'; } } };
        },
        async query(sql, options = {}) {
            assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|\bCALL\b|\bALTER\b|\bDROP\b/i, 'No destructive or implicitly committing SQL in fixture rehearsal');
            const [rows] = await connection.query(injectReplacements(sql, dialect, options.replacements)); return rows;
        }
    });
    stub('../../src/services/email/email.service', new Proxy({}, { get: () => async () => { mailAttempts++; throw Error('External delivery disabled in S18 QA'); } }));
    const requests = require('../../src/Dao/mysql/documentSignatureRequest.dao');
    const publicSign = require('../../src/Dao/mysql/publicDocumentSignature.dao');
    const { hashToken } = require('../../src/services/documentSignature/documentSignatureToken.service');
    const business = uuid(), foreign = uuid(), patient = uuid(), actor = uuid(), role = uuid(), template = uuid();
    const body = { id_business: business, id_login: actor, rol: 's18_qa', signature_role: 'PATIENT', channel: 'qr', expires_in_minutes: 30 };
    const meta = { ip: '127.0.0.1', userAgent: 'S18 synthetic lifecycle rehearsal' };
    const signBody = { accepted_electronic_signature: true, signature_image: png, signed_by_name: 'Firma ficticia S18' };
    const ok = result => { assert.equal(result.status, 200, result.message); return result.data; };
    const unavailable = result => { assert.equal(result.code, 'SIGNATURE_LINK_NOT_AVAILABLE'); assert.equal(result.data, null); };
    const token = result => new URL(result.public_url).pathname.split('/').pop();
    const insert = async (table, values) => { const fields = Object.keys(values); await connection.query(`INSERT INTO \`${table}\` (${fields.map(key => `\`${key}\``).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, Object.values(values)); };
    const documents = [];
    const document = async suffix => {
        const id = uuid(); documents.push(id);
        await insert('patient_documents', { id_patient_document: id, id_business: business, id_person: patient, id_document_template: template,
            document_type: 'CUSTOM', title: `S18 ficticio ${suffix}`, content_html_snapshot: `<p>Contenido ficticio congelado ${suffix}: ñ.</p>`,
            responsible_doctor_user_id: actor, doctor_name_snapshot: 'Doctor ficticio S18', status: 'PENDIENTE_FIRMA', active: 1, created_by: actor });
        return id;
    };
    const status = async id => (await connection.query('SELECT status FROM document_signature_requests WHERE id_document_signature_request=?', [id]))[0][0].status;
    try {
        await connection.beginTransaction();
        for (const id of [business, foreign]) await insert('business', { id_business: id, name: 'S18 ficticio', slug: `s18-${id}`, plan: 'enterprise', active: 1 });
        await insert('rol', { id_rol: role, code: `s18_${role}`, desc_rol: 'S18 synthetic role', active: 1 });
        await insert('login', { id_login: actor, id_business: business, id_rol: role, name: 'S18 ficticio', active: 1 });
        const [permissions] = await connection.query("SELECT id_cat_permission FROM cat_permission WHERE code='documents.signature.request' AND active=1 LIMIT 1");
        assert.equal(permissions.length, 1, 'Signature-request permission must exist');
        await insert('business_role_permission', { id_business: business, id_rol: role, id_cat_permission: permissions[0].id_cat_permission, active: 1 });
        await insert('person', { id_person: patient, id_business: business, name: 'Paciente ficticio', surname: 'S18', active: 1 });
        await insert('document_templates', { id_document_template: template, id_business: business, name: 'S18 synthetic stable template',
            requires_patient_signature: 1, requires_doctor_signature: 0, requires_tutor_signature: 0, requires_witness1_signature: 0, requires_witness2_signature: 0 });
        const main = await document('ciclo completo');
        const initial = ok(await requests.create({ ...body, id_patient_document: main }));
        const initialToken = token(initial);
        const [stored] = await connection.query('SELECT token_hash, TIMESTAMPDIFF(SECOND,created_at,expires_at) AS ttl FROM document_signature_requests WHERE id_document_signature_request=?', [initial.id_document_signature_request]);
        assert.equal(stored[0].token_hash, hashToken(initialToken), 'Only HMAC hash persisted');
        assert.equal(stored[0].ttl, 1800, 'Requested QR TTL stored as thirty minutes');
        assert.equal(ok(await publicSign.openByToken(initialToken, meta)).document.content_html_snapshot, '<p>Contenido ficticio congelado ciclo completo: ñ.</p>');
        assert.equal(await status(initial.id_document_signature_request), 'opened');
        ok(await requests.revoke({ ...body, id_document_signature_request: initial.id_document_signature_request, reason: 'Ensayo ficticio de revocación' }));
        unavailable(await publicSign.openByToken(initialToken, meta));
        unavailable(await publicSign.signByToken(initialToken, signBody, meta));
        const expired = ok(await requests.create({ ...body, id_patient_document: main })), expiredToken = token(expired);
        await connection.query('UPDATE document_signature_requests SET expires_at=DATE_SUB(NOW(),INTERVAL 1 DAY) WHERE id_document_signature_request=?', [expired.id_document_signature_request]);
        unavailable(await publicSign.openByToken(expiredToken, meta));
        assert.equal(await status(expired.id_document_signature_request), 'expired');
        unavailable(await publicSign.signByToken(expiredToken, signBody, meta));
        const replaced = ok(await requests.create({ ...body, id_patient_document: main })), replacedToken = token(replaced);
        const current = ok(await requests.create({ ...body, id_patient_document: main })), currentToken = token(current);
        assert.equal(await status(replaced.id_document_signature_request), 'revoked', 'Reissue revokes previous current link');
        unavailable(await publicSign.openByToken(replacedToken, meta));
        unavailable(await publicSign.signByToken(replacedToken, signBody, meta));
        assert.equal((await publicSign.signByToken(currentToken, { ...signBody, accepted_electronic_signature: false }, meta)).status, 400);
        assert.equal((await publicSign.signByToken(currentToken, { ...signBody, signature_image: 'data:image/png;base64,AAAA' }, meta)).status, 400);
        const signed = ok(await publicSign.signByToken(currentToken, signBody, meta));
        assert.equal(signed.document_status, 'FIRMADO');
        unavailable(await publicSign.signByToken(currentToken, signBody, meta));
        unavailable(await publicSign.openByToken(currentToken, meta));
        const [signatures] = await connection.query('SELECT signature_image FROM patient_document_signatures WHERE id_patient_document=?', [main]);
        assert.equal(signatures.length, 1, 'Replayed token cannot create duplicate signatures'); assert.equal(signatures[0].signature_image, png);
        const [frozen] = await connection.query('SELECT content_html_snapshot,signed_content_html_snapshot,status FROM patient_documents WHERE id_patient_document=?', [main]);
        assert.equal(frozen[0].content_html_snapshot, frozen[0].signed_content_html_snapshot);
        assert.equal((await requests.create({ ...body, id_patient_document: main })).status, 400, 'Signed document cannot be reissued');
        const pending = await document('restricciones');
        assert.equal((await requests.create({ ...body, id_business: foreign, id_patient_document: pending })).status >= 400, true, 'Foreign tenant cannot create link for document');
        await connection.query('UPDATE business_role_permission SET active=0 WHERE id_business=? AND id_rol=? AND id_cat_permission=?', [business, role, permissions[0].id_cat_permission]);
        assert.equal((await requests.create({ ...body, id_patient_document: pending })).status, 403);
        await connection.query('UPDATE business_role_permission SET active=1 WHERE id_business=? AND id_rol=? AND id_cat_permission=?', [business, role, permissions[0].id_cat_permission]);
        const inactive = ok(await requests.create({ ...body, id_patient_document: pending })), inactiveToken = token(inactive);
        await connection.query('UPDATE patient_documents SET active=0 WHERE id_patient_document=?', [pending]);
        unavailable(await publicSign.openByToken(inactiveToken, meta));
        unavailable(await publicSign.signByToken(inactiveToken, signBody, meta));
        const [events] = await connection.query('SELECT event_type,notes FROM patient_document_events WHERE id_business=?', [business]);
        for (const expected of ['SIGNATURE_LINK_CREATED', 'SIGNATURE_LINK_OPENED', 'SIGNATURE_LINK_REVOKED', 'SIGNATURE_LINK_EXPIRED', 'SIGNATURE_LINK_SIGNED', 'SIGNED']) assert.ok(events.some(row => row.event_type === expected), `Missing audit event ${expected}`);
        const eventText = JSON.stringify(events);
        for (const secret of [initialToken, expiredToken, replacedToken, currentToken, inactiveToken]) assert.equal(eventText.includes(secret), false, 'Raw tokens never appear in event notes');
        assert.equal(mailAttempts, 0, 'No email, SMS, WhatsApp or actual recipient delivery');
        await connection.rollback();
        const [remaining] = await connection.query('SELECT id_patient_document FROM patient_documents WHERE id_person=?', [patient]);
        assert.equal(remaining.length, 0);
        console.log('PASS S18 remote signature lifecycle: real DAO+SQL permissions, synthetic QR creation/open/revoke/expire/reissue, old-token rejection, dummy PNG signing once, immutable HTML, audit events without raw tokens, inactive/cross-tenant rejection. One connection; fixtures rolled back; no deliveries.');
    } finally {
        await connection.rollback(); await connection.end();
        for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
})().catch(error => { console.error('S18 signature lifecycle failed:', String(error.message).replace(/\/sign\/d\/[A-Za-z0-9_-]+/g, '/sign/d/[redacted]').replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')); process.exitCode = 1; });

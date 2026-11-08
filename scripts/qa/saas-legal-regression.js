'use strict';
// Real DAO/validator/controllers/routers with serialized in-memory transactions.
// No database, HTTP server, legal publications or real acceptances are created.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const stub = (modulePath, exports) => { const id = require.resolve(modulePath); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../../src/db/Sequelize.connection', {});
const { SaasLegalDao } = require('../../src/Dao/mysql/saasLegal.dao');
const { validateDraft, validateAcceptance } = require('../../src/validators/saasLegal.validator');
const keys = ['terms_conditions', 'privacy_notice', 'license_agreement'];
const scopes = ['user', 'user', 'business'];
const contexts = {
    user: { id_login: 'qa-user', id_business: 'qa-tenant', rol: 'doctor' },
    second: { id_login: 'qa-second', id_business: 'qa-tenant', rol: 'doctor' },
    admin: { id_login: 'qa-admin', id_business: 'qa-tenant', rol: 'admin' },
    other: { id_login: 'qa-other', id_business: 'qa-other-tenant', rol: 'doctor' },
    super: { id_login: 'qa-super', rol: 'super_admin' }
};
class MemoryDb {
    constructor() {
        this.state = { heads: keys.map((key, i) => ({ id_document: 'qa-document-' + i, document_key: key, acceptance_scope: scopes[i],
            draft_title: 'Documento QA ' + i, draft_description: '', draft_content_html: '', draft_required: 1, draft_revision: 1, current_version_id: null })),
        versions: [], acceptances: [], actors: Object.values(contexts).map(actor => ({ ...actor, name: 'Nombre ' + actor.id_login, role: actor.rol, active: true })) };
        this.queue = Promise.resolve(); this.calls = []; this.failInsert = false;
    }
    async transaction() {
        const wait = this.queue; let release; this.queue = new Promise(done => { release = done; }); await wait;
        const snapshot = structuredClone(this.state), transaction = { finished: null };
        transaction.commit = async () => { transaction.finished = 'commit'; release(); };
        transaction.rollback = async () => { this.state = snapshot; transaction.finished = 'rollback'; release(); };
        return transaction;
    }
    async query(sql, options) {
        this.calls.push({ sql, options }); const p = options.replacements || {}, state = this.state;
        if(sql.includes('FROM registration_outbox')) return [];
        if(sql.includes('FROM login l')) return state.actors.filter(actor => actor.id_login === p.actor && actor.active && (!sql.includes('l.id_business COLLATE') || actor.id_business === p.business)).map(actor => ({ ...actor }));
        if(sql.startsWith('SELECT * FROM saas_legal_documents')) {
            const rows = state.heads.filter(head => p.key ? head.document_key === p.key : p.document ? head.id_document === p.document : true).map(head => ({ ...head }));
            if(this.afterHeadsRead && !p.key && !p.document) { const run = this.afterHeadsRead; this.afterHeadsRead = null; run(); }
            return rows;
        }
        if(sql.startsWith('SELECT * FROM saas_legal_versions')) return state.versions.filter(version => p.version ? version.id_version === p.version : version.id_document === p.document).sort((a, b) => b.version_number - a.version_number).map(version => ({ ...version }));
        if(sql.startsWith('SELECT v.*')) return state.versions.filter(version => Object.values(p).includes(version.id_version)).map(version => ({ ...version }));
        if(sql.startsWith('SELECT * FROM saas_legal_acceptances')) {
            // A nonlocking read in an older REPEATABLE READ snapshot cannot see
            // another transaction's newly committed acceptance. FOR UPDATE can.
            if(this.staleAcceptanceSnapshot && p.version && !/FOR UPDATE/.test(sql)) return [];
            return state.acceptances.filter(row => row.id_business === p.business && (p.version ? row.id_version === p.version && row.subject_key === p.subject : row.subject_key === p.subject || row.subject_key === 'business')).map(row => ({ ...row }));
        }
        if(sql.startsWith('SELECT a.*')) return state.acceptances.filter(row => row.id_business === p.business && (row.subject_key === p.subject || row.subject_key === 'business')).map(row => {
            const version = state.versions.find(item => item.id_version === row.id_version), head = state.heads.find(item => item.id_document === version.id_document);
            return { ...version, ...row, document_key: head.document_key };
        });
        if(sql.startsWith('INSERT INTO saas_legal_versions')) {
            if(this.failInsert) throw new Error('SQL/internal/private detail');
            state.versions.push({ id_version: p.id, id_document: p.document, version_number: p.number, title: p.title, description: p.description,
                content_html: p.content_html, content_hash: p.hash, acceptance_scope: p.scope, required: p.required, published_at: '2026-10-17 15:30:00.000000' }); return [];
        }
        if(sql.startsWith('INSERT INTO saas_legal_acceptances')) {
            if(this.failInsert) throw new Error('SQL/internal/private detail');
            assert.ok(!state.acceptances.some(row => row.id_version === p.version && row.id_business === p.business && row.subject_key === p.subject));
            state.acceptances.push({ id_acceptance: p.id, id_version: p.version, id_business: p.business, subject_key: p.subject,
                acceptance_scope: p.scope, accepted_by_id: p.actor, accepted_by_name: p.name, accepted_at: '2026-10-17 15:35:00.000000', content_hash: p.hash }); return [];
        }
        if(sql.startsWith('UPDATE saas_legal_documents')) {
            const head = state.heads.find(row => row.id_document === p.document); head.draft_revision++;
            if(sql.includes('SET current_version_id')) head.current_version_id = p.id;
            else Object.assign(head, { draft_title: p.title, draft_description: p.description, draft_content_html: p.content_html, draft_required: p.required });
            return [1];
        }
        throw new Error('Unexpected mocked query: ' + sql.slice(0, 60));
    }
}
const db = new MemoryDb(), dao = new SaasLegalDao(db);
const draft = (revision, html = '<p>Texto ficticio QA sin validez legal.</p>') => ({ title: '  Documento ficticio QA  ', description: '  Descripción QA  ', content_html: html, required: true, expected_revision: revision });
async function publish(key, html) {
    const head = db.state.heads.find(row => row.document_key === key);
    let result = await dao.saveDraft(contexts.super, key, draft(head.draft_revision, html)); assert.equal(result.success, true);
    result = await dao.publish(contexts.super, key, { expected_revision: result.data.document.draft.revision }); assert.equal(result.success, true);
    return result.data.document.current_version;
}
(async () => {
    assert.equal(validateDraft('terms_conditions', { ...draft(1), acceptance_scope: 'business' }).isValid, false);
    assert.equal(validateDraft('terms_conditions', draft(1, '')).isValid, true, 'Blank drafts remain editable');
    assert.equal(validateAcceptance({ id_version: 'qa-version', acknowledged: 'true' }).isValid, false);
    const empty = await dao.current(contexts.user); assert.equal(empty.data.documents.length, 3); assert.equal(empty.data.pending_count, 0);
    assert.ok(empty.data.documents.every(document => !document.current_version && !document.can_accept && !document.pending));
    assert.equal(db.calls.some(call => call.sql.startsWith('SELECT v.*')), false, 'No version lookup or empty IN clause for unpublished heads');
    assert.equal((await dao.publicDocument('terms_conditions')).status, 404);
    assert.equal((await dao.publicDocument('license_agreement')).status, 404);
    assert.equal((await dao.adminList(contexts.user)).status, 403);
    assert.equal((await dao.publish(contexts.super, 'terms_conditions', { expected_revision: 1 })).status, 400);
    let result = await dao.saveDraft(contexts.super, 'terms_conditions', draft(1, '<p>  </p><script>bad()</script>'));
    assert.equal(result.success, true); assert.doesNotMatch(result.data.document.draft.content_html, /script|bad\(/);
    assert.equal((await dao.publish(contexts.super, 'terms_conditions', { expected_revision: 2 })).status, 400);
    assert.equal((await dao.saveDraft(contexts.super, 'terms_conditions', draft(1))).code, 'LEGAL_DRAFT_CONFLICT');
    const v1 = await publish('terms_conditions');
    assert.match(v1.content_hash, /^[a-f0-9]{64}$/); assert.equal(v1.published_at, '2026-10-17T15:30:00.000Z');
    assert.equal((await dao.publicDocument('terms_conditions')).data.document.current_version.id_version, v1.id_version);
    const noChangeHead = db.state.heads.find(row => row.document_key === 'terms_conditions');
    assert.equal((await dao.publish(contexts.super, 'terms_conditions', { expected_revision: noChangeHead.draft_revision })).code, 'LEGAL_ALREADY_PUBLISHED');
    const current = await dao.current(contexts.user); assert.equal(current.data.pending_count, 1); assert.equal(current.data.documents.find(item => item.document_key === 'terms_conditions').can_accept, true);
    assert.equal((await dao.accept(contexts.user, { id_version: v1.id_version, acknowledged: false })).status, 400);
    const accepts = await Promise.all([dao.accept(contexts.user, { id_version: v1.id_version, acknowledged: true }), dao.accept(contexts.user, { id_version: v1.id_version, acknowledged: true })]);
    assert.ok(accepts.every(item => item.success)); assert.deepEqual(accepts.map(item => item.data.already_accepted).sort(), [false, true]);
    assert.equal(db.state.acceptances.length, 1); assert.equal(accepts[0].data.acceptance.accepted_at, '2026-10-17T15:35:00.000Z');
    db.staleAcceptanceSnapshot = true;
    const afterConcurrentCommit = await dao.accept(contexts.user, { id_version: v1.id_version, acknowledged: true });
    assert.equal(afterConcurrentCommit.success, true); assert.equal(afterConcurrentCommit.data.already_accepted, true, 'A locking acceptance lookup sees the concurrent commit despite an older read snapshot');
    db.staleAcceptanceSnapshot = false;
    assert.equal((await dao.current(contexts.second)).data.pending_count, 1, 'Another user does not inherit personal terms acceptance');
    assert.equal((await dao.history(contexts.second)).data.acceptances.length, 0);
    assert.equal((await dao.history(contexts.other)).data.acceptances.length, 0, 'A different tenant sees no acceptance');
    const prior = structuredClone(db.state.versions[0]);
    const v2 = await publish('terms_conditions', '<p>Segundo texto QA revisado.</p>');
    assert.equal(v2.version_number, 2); assert.notEqual(v2.content_hash, v1.content_hash); assert.deepEqual(db.state.versions[0], prior);
    assert.equal((await dao.accept(contexts.user, { id_version: v1.id_version, acknowledged: true })).code, 'LEGAL_VERSION_STALE');
    assert.equal((await dao.current(contexts.user)).data.pending_count, 1, 'A new version requires a fresh explicit acknowledgement');
    const capturedHead = db.state.heads.find(row => row.document_key === 'terms_conditions');
    db.afterHeadsRead = () => {
        db.state.versions.push({ ...db.state.versions.find(row => row.id_version === v2.id_version), id_version: 'qa-interleaved-publication', version_number: 3 });
        capturedHead.current_version_id = 'qa-interleaved-publication';
    };
    const interleavedCurrent = await dao.current(contexts.user);
    assert.equal(interleavedCurrent.data.documents.find(row => row.document_key === 'terms_conditions').current_version.id_version, v2.id_version, 'A publish between head/version reads returns the captured immutable version, never Sin publicar');
    capturedHead.current_version_id = v2.id_version;
    db.state.versions = db.state.versions.filter(row => row.id_version !== 'qa-interleaved-publication');
    const history = await dao.history(contexts.user);
    assert.equal(history.data.acceptances[0].version.id_version, v1.id_version); assert.equal(history.data.acceptances[0].version.content_html, prior.content_html);
    assert.equal(history.data.acceptances[0].accepted_by_name, 'Nombre qa-user');
    const license = await publish('license_agreement');
    assert.equal((await dao.accept(contexts.user, { id_version: license.id_version, acknowledged: true })).code, 'LEGAL_ADMIN_REQUIRED');
    assert.equal((await dao.accept(contexts.admin, { id_version: license.id_version, acknowledged: true })).success, true);
    assert.ok((await dao.current(contexts.second)).data.documents.find(item => item.document_key === 'license_agreement').accepted);
    assert.equal((await dao.history(contexts.second)).data.acceptances.length, 1, 'Business acceptance is shared only inside that tenant');
    assert.equal((await dao.adminVersion(contexts.super, 'privacy_notice', v1.id_version)).status, 404);
    const actor = db.state.actors.find(row => row.id_login === contexts.admin.id_login); actor.role = 'doctor';
    const license2 = await publish('license_agreement', '<p>Nueva versión QA del contrato.</p>');
    assert.equal((await dao.accept(contexts.admin, { id_version: license2.id_version, acknowledged: true })).status, 403, 'Stale admin token does not confer authority');
    const movedActor = db.state.actors.find(row => row.id_login === contexts.admin.id_login);
    movedActor.role = 'admin'; movedActor.id_business = 'qa-moved-tenant';
    assert.equal((await dao.current(contexts.admin)).status, 403, 'A moved user cannot use the former tenant token');
    db.failInsert = true; const before = structuredClone(db.state);
    const failed = await dao.accept(contexts.user, { id_version: v2.id_version, acknowledged: true });
    assert.equal(failed.status, 500); assert.doesNotMatch(JSON.stringify(failed), /SQL|internal|private/); assert.deepEqual(db.state, before);
    db.failInsert = false;
    assert.ok(db.calls.filter(call => call.sql.startsWith('SELECT * FROM saas_legal_documents') && call.options.transaction).some(call => /FOR UPDATE/.test(call.sql)));
    assert.ok(db.calls.filter(call => call.sql.includes('FROM login l') && /FOR UPDATE/.test(call.sql)).length, 'Acceptance revalidates and locks the current actor');

    let captured;
    stub('../../src/Dao/mysql/saasLegal.dao', { current: async context => ({ status: 200, success: true, data: context }),
        accept: async (context, payload) => { captured = { context, payload }; return { status: 200, success: true, data: {} }; },
        publicDocument: async key => ({ status: 200, success: true, data: { key } }),
        history: async () => ({ status: 200, success: true, data: {} }), adminList: async () => ({ status: 200, success: true, data: {} }),
        saveDraft: async () => ({ status: 200, success: true, data: {} }), publish: async () => ({ status: 200, success: true, data: {} }), adminVersion: async () => ({ status: 200, success: true, data: {} }) });
    const controller = require('../../src/controller/mysql/saasLegal.controller');
    const res = { status() { return this; }, send(value) { this.value = value; return this; } };
    await controller.accept({ tokenDecode: contexts.user, body: { id_version: v2.id_version, acknowledged: true, id_login: 'injected', id_business: 'injected', rol: 'admin' } }, res);
    assert.deepEqual(captured, { context: { ...contexts.user, id_session: contexts.user.id_session }, payload: { id_version: v2.id_version, acknowledged: true } });
    stub('../../src/auth/authenticate', { Auth: (req, response, next) => req.tokenDecode ? next() : response.status(401).send({ status: 401 }) });
    stub('../../src/middleware/requireTenantOperational.middleware', (req, response, next) => req.operational === false ? response.status(403).send({ status: 403 }) : next());
    stub('../../src/middleware/csrf.middleware', { csrfProtection: () => (req, response, next) => req.csrf ? next() : response.status(403).send({ status: 403 }) });
    const tenantRouter = require('../../src/routes/mysql/saas-legal'), adminRouter = require('../../src/routes/mysql/super-admin-saas-legal');
    const request = (router, method, url, extras = {}) => new Promise((resolve, reject) => {
        const response = { status(value) { this.statusCode = value; return this; }, send(body) { resolve({ status: this.statusCode, body }); return this; } };
        router.handle({ method, url, originalUrl: url, headers: {}, body: {}, ...extras }, response, error => error ? reject(error) : resolve({ status: 404 }));
    });
    assert.equal((await request(tenantRouter, 'GET', '/public/terms_conditions')).status, 200);
    assert.equal((await request(tenantRouter, 'GET', '/')).status, 401);
    assert.equal((await request(tenantRouter, 'GET', '/', { tokenDecode: contexts.user, operational: false })).status, 200, 'Authenticated legal access remains available for restricted/expired tenants');
    assert.equal((await request(tenantRouter, 'POST', '/accept', { tokenDecode: contexts.user })).status, 403);
    assert.equal((await request(adminRouter, 'GET', '/', { tokenDecode: contexts.user })).status, 403);
    assert.equal((await request(adminRouter, 'GET', '/', { tokenDecode: contexts.super })).status, 200);
    assert.equal((await request(adminRouter, 'PUT', '/terms_conditions', { tokenDecode: contexts.super })).status, 403);
    const sql = fs.readFileSync(require.resolve('../migrations/saas-legal-documents.sql'), 'utf8');
    assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 3);
    assert.match(sql, /UNIQUE KEY uq_saas_legal_version_subject/); assert.match(sql, /INSERT IGNORE INTO saas_legal_documents/);
    assert.equal((sql.match(/CREATE TRIGGER/g) || []).length, 4); assert.doesNotMatch(sql, /DROP TABLE|INSERT INTO saas_legal_versions|INSERT INTO saas_legal_acceptances/);
    console.log('PASS SaaS legal: empty drafts/public isolation, sanitizer, revision conflicts, immutable publication/hash, captured-head publication interleaving, stale REPEATABLE READ acceptance snapshot/current locking lookup, explicit/idempotent acceptance, per-user/tenant scopes, actual admin/actor checks, frozen history, rollback/safe failures, restricted-tenant+CSRF+SuperAdmin routes, body injection defense and additive schema guards. In-memory only.');
})().catch(error => { console.error(error); process.exitCode = 1; });

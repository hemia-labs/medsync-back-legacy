'use strict';
// Requires the additive schema first. One connection, one outer transaction;
// DAO transactions are savepoints. Every fixture/publication/acceptance rolls back.
require('../../src/config/env');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');
const id = () => 'QAL_' + randomUUID();
const clone = value => JSON.parse(JSON.stringify(value));
const ok = response => { assert.equal(response.status, 200, response.message); assert.equal(response.success, true); return response.data; };

(async () => {
    let connection, outerTransaction = false, stage = 'connect';
    const businesses = [id(), id()], actors = { user: id(), second: id(), other: id(), admin: id(), super: id() };
    const actorIds = Object.values(actors), versionIds = [], acceptanceIds = [];
    try {
        connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL,
            password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, namedPlaceholders: true, timezone: 'Z' });
        stage = 'schema-and-seed';
        const [tables] = await connection.execute(`SELECT table_name FROM information_schema.tables
            WHERE table_schema=DATABASE() AND table_name IN ('saas_legal_documents','saas_legal_versions','saas_legal_acceptances')`);
        assert.equal(tables.length, 3, 'Apply the additive SaaS legal schema before this test');
        const [roles] = await connection.execute("SELECT id_rol,code FROM rol WHERE active=1 AND code IN ('super_admin','admin','business_admin','doctor')");
        const role = code => roles.find(row => row.code === code);
        const adminRole = role('admin') || role('business_admin');
        assert.ok(role('doctor') && role('super_admin') && adminRole, 'Existing active roles are required; this test never changes role definitions');
        await connection.beginTransaction(); outerTransaction = true;
        const [baselineHeads] = await connection.execute('SELECT * FROM saas_legal_documents ORDER BY document_key FOR UPDATE');
        assert.equal(baselineHeads.length, 3);
        assert.ok(baselineHeads.every(row => !row.current_version_id && !row.draft_content_html), 'Use only a freshly seeded, unpublished legal module');
        const [existingVersions] = await connection.execute('SELECT COUNT(*) AS total FROM saas_legal_versions');
        assert.equal(Number(existingVersions[0].total), 0, 'Do not run over real published legal records');

        for(const [index, business] of businesses.entries()) await connection.execute(`INSERT INTO business
            (id_business,name,slug,status,subscription_status,active,created_by) VALUES (?,?,?,?,'expired',1,'QA_LEGAL_ROLLBACK')`,
        [business, 'QA Legal ficticio ' + index, 'qa-legal-' + randomUUID(), index === 0 ? 'suspended' : 'active']);
        for(const [name, actor] of Object.entries(actors)) {
            const selectedRole = name === 'super' ? role('super_admin') : name === 'admin' ? adminRole : role('doctor');
            await connection.execute(`INSERT INTO login (id_login,id_business,id_rol,name,email,locked,active,created_by)
                VALUES (?,?,?,?,?,0,1,'QA_LEGAL_ROLLBACK')`,
            [actor, name === 'super' ? null : name === 'other' ? businesses[1] : businesses[0], selectedRole.id_rol, 'QA Legal ' + name, actor.toLowerCase() + '@example.invalid']);
        }
        let serial = 0;
        const adapter = {
            async transaction() {
                const savepoint = 'qa_legal_' + ++serial; await connection.query('SAVEPOINT ' + savepoint);
                return { finished: null,
                    async commit() { await connection.query('RELEASE SAVEPOINT ' + savepoint); this.finished = 'commit'; },
                    async rollback() { await connection.query('ROLLBACK TO SAVEPOINT ' + savepoint); await connection.query('RELEASE SAVEPOINT ' + savepoint); this.finished = 'rollback'; } };
            },
            async query(sql, options = {}) {
                assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|\bCALL\b|\bALTER\b|\bDROP\b/i, 'DAO must never mutate frozen versions or schema');
                const [rows] = await connection.execute(sql, options.replacements || {}); return rows;
            }
        };
        const { SaasLegalDao } = require('../../src/Dao/mysql/saasLegal.dao');
        const dao = new SaasLegalDao(adapter);
        const context = name => ({ id_login: actors[name], id_business: name === 'super' ? undefined : name === 'other' ? businesses[1] : businesses[0],
            rol: name === 'super' ? 'super_admin' : name === 'admin' ? adminRole.code : 'doctor' });
        const publish = async (key, html) => {
            const list = ok(await dao.adminList(context('super'))), current = list.documents.find(document => document.document_key === key);
            const saved = ok(await dao.saveDraft(context('super'), key, { title: 'QA ficticio sin validez legal', description: 'Sólo QA con rollback',
                content_html: html, required: true, acceptance_scope: key === 'license_agreement' ? 'business' : 'user', expected_revision: current.draft.revision }));
            const result = ok(await dao.publish(context('super'), key, { expected_revision: saved.document.draft.revision }));
            versionIds.push(result.document.current_version.id_version); return result.document;
        };
        const accept = async (name, version) => {
            const result = ok(await dao.accept(context(name), { id_version: version, acknowledged: true }));
            acceptanceIds.push(result.acceptance.id_acceptance); return result;
        };
        stage = 'unpublished';
        assert.equal(ok(await dao.current(context('user'))).pending_count, 0, 'Restricted tenant can read legal metadata');
        assert.equal((await dao.publicDocument('terms_conditions')).status, 404);
        assert.equal((await dao.publish(context('super'), 'terms_conditions', { expected_revision: 1 })).status, 400);
        stage = 'first-publication';
        const first = await publish('terms_conditions', '<p>Primer texto QA. Sin validez legal.</p>'), v1 = first.current_version;
        assert.equal(v1.version_number, 1); assert.match(v1.published_at, /Z$/);
        assert.equal(ok(await dao.publicDocument('terms_conditions')).document.current_version.id_version, v1.id_version);
        assert.equal((await dao.publish(context('super'), 'terms_conditions', { expected_revision: first.draft.revision - 1 })).code, 'LEGAL_DRAFT_CONFLICT');
        const accepted1 = await accept('user', v1.id_version), repeated = await accept('user', v1.id_version);
        assert.equal(accepted1.already_accepted, false); assert.equal(repeated.already_accepted, true);
        assert.equal(repeated.acceptance.id_acceptance, accepted1.acceptance.id_acceptance);
        assert.equal(ok(await dao.current(context('second'))).pending_count, 1);
        assert.equal(ok(await dao.history(context('second'))).acceptances.length, 0);
        stage = 'second-publication-and-history';
        const second = await publish('terms_conditions', '<p>Segundo texto QA revisado. Sin validez legal.</p>'), v2 = second.current_version;
        assert.equal(v2.version_number, 2); assert.notEqual(v1.content_hash, v2.content_hash);
        assert.equal((await dao.accept(context('user'), { id_version: v1.id_version, acknowledged: true })).code, 'LEGAL_VERSION_STALE');
        assert.equal(ok(await dao.current(context('user'))).pending_count, 1);
        await accept('user', v2.id_version);
        const ownHistory = ok(await dao.history(context('user'))).acceptances;
        assert.equal(ownHistory.length, 2); assert.equal(ownHistory.find(row => row.id_version === v1.id_version).version.content_html, v1.content_html);
        assert.equal(ownHistory.find(row => row.id_version === v1.id_version).content_hash, v1.content_hash);
        assert.equal(ok(await dao.history(context('other'))).acceptances.length, 0);
        await accept('other', v2.id_version);
        const otherHistory = ok(await dao.history(context('other'))).acceptances;
        assert.equal(otherHistory.length, 1); assert.equal(otherHistory[0].id_business, businesses[1]);
        assert.equal(otherHistory[0].accepted_by_id, actors.other);
        stage = 'business-scope';
        const license = await publish('license_agreement', '<p>Contrato ficticio QA sin validez legal.</p>');
        assert.equal((await dao.accept(context('user'), { id_version: license.current_version.id_version, acknowledged: true })).code, 'LEGAL_ADMIN_REQUIRED');
        await accept('admin', license.current_version.id_version);
        assert.ok(ok(await dao.current(context('second'))).documents.find(row => row.document_key === 'license_agreement').accepted);
        assert.equal(ok(await dao.history(context('second'))).acceptances.length, 1);
        assert.equal(ok(await dao.history(context('other'))).acceptances.length, 1, 'Another tenant never inherits the contract acceptance');
        assert.equal((await dao.publicDocument('license_agreement')).status, 404);
        stage = 'immutability-triggers';
        const triggerRejected = async sql => {
            let rejected = false;
            try { await connection.execute(sql); } catch(error) { rejected = error.code === 'ER_SIGNAL_EXCEPTION' || error.sqlState === '45000'; }
            assert.equal(rejected, true, 'Immutable record update/delete must be rejected by DB trigger');
        };
        await triggerRejected(`UPDATE saas_legal_versions SET title=title WHERE id_version='${v1.id_version}'`);
        await triggerRejected(`DELETE FROM saas_legal_versions WHERE id_version='${v2.id_version}'`);
        await triggerRejected(`UPDATE saas_legal_acceptances SET accepted_by_name=accepted_by_name WHERE id_acceptance='${accepted1.acceptance.id_acceptance}'`);
        await triggerRejected(`DELETE FROM saas_legal_acceptances WHERE id_acceptance='${accepted1.acceptance.id_acceptance}'`);
        const frozen = ok(await dao.adminVersion(context('super'), 'terms_conditions', v1.id_version)).version;
        assert.deepEqual(frozen, v1, 'Version evidence survives rejected writes/deletes');
        stage = 'outer-rollback';
        await connection.rollback(); outerTransaction = false;
        const [restored] = await connection.execute('SELECT * FROM saas_legal_documents ORDER BY document_key');
        assert.deepEqual(clone(restored), clone(baselineHeads), 'Global draft/head state is exactly restored');
        for(const [table, column, values] of [['saas_legal_versions', 'id_version', versionIds], ['saas_legal_acceptances', 'id_acceptance', [...new Set(acceptanceIds)]], ['login', 'id_login', actorIds], ['business', 'id_business', businesses]]) {
            for(const value of values) {
                const [rows] = await connection.execute(`SELECT COUNT(*) AS total FROM ${table} WHERE ${column}=?`, [value]);
                assert.equal(Number(rows[0].total), 0, 'Rollback removed every QA ' + table + ' record');
            }
        }
        console.log('PASS SaaS legal SQL: one connection + savepoints; unpublished seed, publications v1/v2, revision/stale-version conflicts, explicit reacceptance/idempotency, actual admin-only contract, per-user/tenant frozen history, immutable UPDATE/DELETE triggers and complete outer rollback. No legal records or fixtures persisted.');
    } catch(error) {
        console.error(JSON.stringify({ check: 'saas-legal-live-rollback', stage, code: error.code || error.name || 'QA_FAILED', assertion: error.name === 'AssertionError' ? error.message.split('\n')[0] : undefined }));
        process.exitCode = 1;
    } finally {
        if(connection) { if(outerTransaction) await connection.rollback(); await connection.end(); }
    }
})();

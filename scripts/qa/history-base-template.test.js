'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { audit, apply, TEMPLATE_ID, VERSION_ID } = require('../migrations/clinical-history-base-template');

function database({ rows = [], failVersion = false, locked = true } = {}) {
    const calls = [];
    let pending = null;
    return { calls, beginTransaction: async () => { calls.push('BEGIN'); }, commit: async () => { calls.push('COMMIT'); },
        rollback: async () => { calls.push('ROLLBACK'); pending = null; },
        async query(sql) {
            calls.push(sql);
            if (sql.includes('DATABASE()')) return [[{ db: 'qa', host: 'isolated' }]];
            if (sql.includes('GET_LOCK')) return [[{ acquired: locked ? 1 : 0 }]];
            if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
            if (sql.startsWith('SELECT t.')) return [pending ? [pending] : rows];
            if (sql.includes('INSERT INTO clinical_history_template_versions')) {
                if (failVersion) throw Error('SYNTHETIC_INSERT_FAILURE');
                pending = { id_clinical_history_template: TEMPLATE_ID, id_clinical_history_template_version: VERSION_ID,
                    is_active: 1, deleted_at: null, schema_json: '{"sections":[{}]}' };
            }
            return [{}];
        } };
}
test('empty install audit is read only and reports missing prerequisite', async () => {
    const db = database(); assert.equal((await audit(db)).ready, false);
    assert.ok(db.calls.every(sql => sql.startsWith('SELECT')));
});
test('first installation commits the template and version together with a preimage', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-base-'));
    try { const db = database(); assert.equal((await apply(db, dir)).created, true);
        assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'history-base-before.json'))).before.systemTemplates, 0);
        assert.ok(db.calls.includes('COMMIT')); assert.equal(db.calls.filter(sql => sql.startsWith('INSERT')).length, 2);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('existing system format is preserved, without writes or backup overwrite', async () => {
    const db = database({ rows: [{ id_clinical_history_template: 'existing', id_clinical_history_template_version: 'v7', is_active: 1, deleted_at: null, schema_json: '{"sections":[{}]}' }] });
    assert.deepEqual(await apply(db, 'unused'), { ready: true, systemTemplates: 1, templateId: 'existing', versionId: 'v7', created: false });
    assert.ok(!db.calls.some(sql => /INSERT|UPDATE|DELETE/.test(sql)));
});
test('failed version insert rolls back the pair and releases the lock', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-base-'));
    try { const db = database({ failVersion: true }); await assert.rejects(apply(db, dir), /SYNTHETIC_INSERT_FAILURE/);
        assert.ok(db.calls.includes('ROLLBACK')); assert.ok(!db.calls.includes('COMMIT')); assert.match(db.calls.at(-1), /RELEASE_LOCK/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('disabled or orphaned templates require review and cannot be silently reactivated', async () => {
    const db = database({ rows: [{ is_active: 0, deleted_at: null }] });
    await assert.rejects(apply(db, 'unused'), /REQUIRES_REVIEW/); assert.ok(db.calls.includes('ROLLBACK'));
});
test('invalid existing schema, lock failure and missing backup fail closed', async () => {
    await assert.rejects(audit(database({ rows: [{ is_active: 1, deleted_at: null, id_clinical_history_template_version: 'v1', schema_json: 'invalid' }] })), /SCHEMA_INVALID/);
    await assert.rejects(apply(database({ locked: false }), 'unused'), /LOCK_UNAVAILABLE/);
    await assert.rejects(apply(database(), null), /BACKUP_REQUIRED/);
});

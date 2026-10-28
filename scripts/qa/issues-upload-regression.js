'use strict';
const assert = require('node:assert/strict');
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../../src/config/env', {});
stub('../../src/config/config', { BUCKETS: { PROFILE: 'synthetic-profile' } });
let outcome = 'throw', uncertain = false, persisted = false, deleteFails = false;
const deleted = [], journal = [];
stub('../../src/services/recoveryJournal', { async recordUploadCleanup(record) { journal.push({ record }); } });
stub('../../src/services/aws/s3', {
    getBucketbyCode: () => 'synthetic-files',
    async uploadImage() { return { Key: 'new-random-key.png', Location: 'https://synthetic.invalid/new-random-key.png' }; },
    async deleteFile(bucket, key) { if (deleteFails) throw Error('Synthetic deletion outage'); deleted.push({ bucket, key }); }
});
stub('../../src/db/Sequelize.connection', { async query(sql) {
    if (sql.startsWith('SELECT id_person')) return [{ id_person: 'patient' }];
    if (sql.startsWith('SELECT f.*')) { if (uncertain) throw Error('Synthetic DB outage'); return persisted ? [{ url: 'https://synthetic.invalid/new-random-key.png' }] : []; }
    if (outcome === 'throw') throw Error('Synthetic SQL failure');
    if (outcome === 'empty') return [];
    if (outcome === 'code') return [{ Code: 1100 }];
    return [{ id: 'new-record' }];
} });
const files = require('../../src/Dao/mysql/file.Dao');
const body = { id_business: 'tenant', id_person: 'patient', id_login: 'actor', file: 'synthetic', code_cat_files: 'QA' };
(async () => {
    for (const method of ['uploadFile', 'uploaProfilePhoto']) {
        for (outcome of ['throw','empty','code']) {
            const before = deleted.length;
            assert.notEqual((await files[method](body)).status, 200);
            assert.equal(deleted.length, before + 1);
            assert.equal(deleted.at(-1).key, 'new-random-key.png');
        }
        outcome = 'throw'; persisted = true;
        let before = deleted.length;
        assert.equal((await files[method](body)).status, 200, 'Lost SQL response reconciles a confirmed saved object');
        assert.equal(deleted.length, before, 'Never delete an object referenced by SQL');
        persisted = false; uncertain = true;
        assert.notEqual((await files[method](body)).status, 200);
        assert.equal(deleted.length, before);
        assert.match(journal.at(-1).record.reason, /unknown/);
        uncertain = false; deleteFails = true;
        assert.notEqual((await files[method](body)).status, 200);
        assert.equal(journal.at(-1).record.key, 'new-random-key.png');
        assert.doesNotMatch(JSON.stringify(journal.at(-1)), /https:|synthetic-password|patient/);
        deleteFails = false;
    }
    console.log('PASS upload compensation: SQL throw/error/empty, confirmed commit reconciliation, uncertain outcome journal, failed deletion recovery; no external services or files.');
})().catch(error => { console.error(error); process.exitCode = 1; });

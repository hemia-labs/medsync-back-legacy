const assert = require('node:assert/strict');
const connectionPath = require.resolve('../../src/db/Sequelize.connection');
let queries = [], rollbacks = 0;
const db = {
    async transaction() { return { async rollback() { rollbacks++; }, async commit() { assert.fail('Denied cancellation must not commit'); } }; },
    async query(sql, options) {
        queries.push({ sql, options });
        return [{ id_clinical_history: 'qa-history', business_id: 'qa-tenant', status: 'DRAFT',
            clinical_snapshot_json: '{}', template_snapshot_json: '{}', created_by_name: 'QA Doctor', updated_by_name: 'QA Assistant' }];
    }
};
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: db };
const dao = require('../../src/Dao/mysql/clinicalHistory.dao');
(async () => {
    dao.hasPermission = async () => false;
    const denied = await dao.cancel({ id_login: 'qa-assistant', id_business: 'qa-tenant', id_clinical_history: 'qa-history' });
    assert.equal(denied.status, 403, 'Permission denial is forbidden, not expired authentication');
    assert.equal(rollbacks, 1);
    assert.equal(queries.length, 0, 'Denied cancellation cannot read or update clinical data');
    const history = await dao.getHistoryById('qa-history', 'qa-tenant');
    assert.equal(dao.hydrate(history).updated_by_name, 'QA Assistant');
    const { sql, options } = queries[0];
    assert.equal(options.replacements._business_id, 'qa-tenant');
    assert.equal(options.replacements._id_clinical_history, 'qa-history');
    assert.match(sql, /LEFT JOIN login creator/);
    assert.match(sql, /creator.id_business COLLATE .* = ch.business_id COLLATE/);
    assert.match(sql, /editor.id_business COLLATE .* = ch.business_id COLLATE/);
    assert.match(sql, /cht.business_id IS NULL OR/);
    assert.match(sql, /WHERE ch.id_clinical_history/);
    assert.match(sql, /AND ch.business_id/);
    assert.equal(queries.length, 1, 'Names and template metadata use the existing query');
    console.log('PASS clinical history: forbidden cancellation, rollback without clinical access, optional tenant-scoped metadata in one query. Mock database; no writes.');
})().catch(error => { console.error(error); process.exitCode = 1; });

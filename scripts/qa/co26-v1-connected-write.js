'use strict';
// DAO transaction regression with a fake connection. Never loads DB configuration.
const assert = require('node:assert/strict');
const id = require.resolve('../../src/db/Sequelize.connection');
let commits = 0, rollbacks = 0, writes = 0;
require.cache[id] = { id, filename: id, loaded: true, exports: {
    query: async () => [{ odontogram_mode: 'v1' }],
    transaction: async () => ({
        finished: false,
        async commit() { commits++; this.finished = true; },
        async rollback() { rollbacks++; this.finished = true; }
    })
} };
const dao = require('../../src/Dao/mysql/odontogram.Dao');
dao.queryV1 = async (sql) => {
    if (/FROM person p/.test(sql)) return [{ id_person: 'patient', id_business: 'tenant' }];
    if (/FROM odontogramv1/.test(sql)) return [{ id_odontogramv1: 'chart', type: 'permanent' }];
    if (/FROM cat_tooth/.test(sql)) return [{ id_tooth: 'tooth' }];
    if (/FROM odontogramDetailv1/.test(sql)) return [{ id_odontogram_detailv1: 'detail', treatment: 'Original' }];
    if (/^UPDATE|^INSERT/.test(sql)) { writes++; return []; }
    throw new Error('Unexpected SQL in isolated test');
};
const body = { id_login: 'actor', id_person: 'patient', id_tooth: 'tooth',
    id_odontogramv1: 'chart', id_odontogram_detailv1: 'detail', treatment: 'Updated', expected_treatment: 'Original' };
(async () => {
    assert.equal((await dao.saveOdontogramvDetailv1({ ...body, id_odontogramv1: 'old-chart' })).status, 409);
    assert.equal(writes, 0);
    assert.equal((await dao.saveOdontogramvDetailv1({ ...body, expected_treatment: 'Stale' })).status, 409);
    assert.equal(writes, 0);
    const response = await dao.saveOdontogramvDetailv1(body);
    assert.equal(response.status, 200);
    assert.equal(writes, 1);
    assert.equal(commits, 1);
    assert.equal(rollbacks, 2);
    console.log('PASS connected write: stale chart/text rejected without writes; matching snapshot commits once. Fake DB only.');
})().catch(error => { console.error(error); process.exitCode = 1; });

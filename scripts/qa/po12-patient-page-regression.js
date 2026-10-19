'use strict';
const assert = require('node:assert/strict');
let calls = [], total = 83, canArchive = false;
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../../src/config/config', {});
stub('../../src/services/aws/s3', {});
stub('../../src/util/effectivePermissions', { hasPermission: async (actor, permission) => {
    assert.equal(actor, 'actor'); assert.equal(permission, 'px.new'); return canArchive;
} });
stub('../../src/db/Sequelize.connection', { async query(sql, options) {
    calls.push({ sql, options });
    if (sql.includes('COUNT(*) AS totalPatients')) return [{ totalPatients: 100, total, withOccupation: 67 }];
    return [{ id_person: 'patient', name: 'Synthetic', code: '000001', active: 1 }];
} });
const dao = require('../../src/Dao/mysql/px.dao');
const controller = require('../../src/controller/mysql/px.controller');
const { validatePxSearchPage: validate } = require('../../src/validators/px.validator');
const { isMinimalReadAllowed } = require('../../src/middleware/requireTenantOperational.middleware');
async function page(term = '', options = {}) { calls = []; return dao.getPxSearchPage(term, 'tenant', options); }
(async () => {
    let result = await page('', { page: 2, pageSize: 8 });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.pagination, { page: 2, pageSize: 8, pageCount: 11, total: 83, totalPatients: 100, withOccupation: 67 });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.replacements.offset, 8);
    assert.equal(calls[1].options.replacements.limit, 8);
    assert.ok(calls.every(call => call.sql.includes('p.id_business = :business') && call.sql.includes('p.active = 1') && call.options.replacements.business === 'tenant'));
    assert.match(calls[1].sql, /p.id_person ASC LIMIT :limit OFFSET :offset/);
    assert.doesNotMatch(calls[1].sql, /p\.\*|rfc|id_signature|clinical|diagnosis/i, 'Directory is a minimal projection');
    await page('20%_=test', { includeArchived: true });
    assert.equal(calls[1].options.replacements.term, '%20=%=_==test%');
    assert.ok(calls.every(call => call.sql.includes('p.active IN (0, 1)') && !call.sql.includes('20%_=test')));
    result = await page('', { page: 1000000, pageSize: 50 });
    assert.equal(result.data.pagination.page, 2, 'Deleted rows/out-of-range page clamp to last page');
    assert.equal(calls[1].options.replacements.offset, 50);
    total = 0;
    result = await page('no-match');
    assert.equal(calls.length, 1, 'No matching patients, no result query');
    assert.deepEqual(result.data.items, []);
    for (const payload of [{ param: {} }, { param: 'x'.repeat(121) }, { param: '', page: 0 },
        { param: '', page: '2' }, { param: '', page: 1000001 }, { param: '', page_size: 51 }, { param: '', page_size: 1.1 }]) {
        assert.equal(validate({ body: payload }).isValid, false);
    }
    assert.equal(validate({ body: { param: '', page: 1, page_size: 8 } }).isValid, true);
    assert.equal(isMinimalReadAllowed({ method: 'POST', baseUrl: '/api/px', path: '/search-page' }), true, 'Limited tenant state preserves the existing read-only directory access');
    assert.equal(isMinimalReadAllowed({ method: 'POST', baseUrl: '/api/px', path: '/search-fast' }), false);
    calls = [];
    assert.equal((await dao.getPxSearchPage('', null)).status, 403);
    assert.equal((await dao.getPxSearchPage('', 'tenant', { pageSize: 999 })).status, 400);
    assert.equal(calls.length, 0, 'Invalid input cannot reach SQL');
    for (const allowed of [false, true]) {
        canArchive = allowed; calls = [];
        const req = { body: { param: '', page: 1, page_size: 8, include_archived: true, id_business: 'foreign' },
            tokenDecode: { id_login: 'actor', id_business: 'tenant' } };
        const res = { status(code) { this.code = code; return this; }, send(value) { this.body = value; } };
        await controller.getPxSearchPage(req, res);
        assert.equal(res.code, 200);
        assert.equal(calls[0].options.replacements.business, 'tenant', 'Tenant comes exclusively from active token');
        assert.ok(calls[0].sql.includes(allowed ? 'p.active IN (0, 1)' : 'p.active = 1'), 'Archived access needs px.new');
    }
    console.log('PASS PO12 patient paging: bounded deterministic SQL, accurate totals, escaped wildcard search, minimal projection, page clamp/empty, input guards and token tenant/archive authorization. No DB.');
})().catch(error => { console.error(error); process.exitCode = 1; });

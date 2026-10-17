const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const stub = (file, value) => { const id = require.resolve(path.resolve(__dirname, '../../src', file)); require.cache[id] = { id, filename: id, loaded: true, exports: value }; };
let calls = [], mode = 'administrative', tenantFound = true, childFound = true, committed = 0;
const db = {
    async transaction() { return { async commit() { committed++; }, async rollback() {} }; },
    async query(sql, options = {}) {
        calls.push({ sql, options });
        assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|SP_px_force/i);
        if (/SELECT id_person FROM person/.test(sql)) return tenantFound ? [{ id_person: 'patient-a' }] : [];
        if (/SELECT id_address FROM address/.test(sql)) return childFound ? [{ id_address: 'address-a' }] : [];
        if (/SELECT id_query FROM query/.test(sql)) return childFound ? [{ id_query: 'query-a' }] : [];
        if (/FROM pathological_personal/.test(sql)) return [{ json: '{"clinical":"private"}' }];
        if (/FROM person p/.test(sql)) {
            if (mode === 'administrative') {
                assert.doesNotMatch(sql, /id_signature|name_signature|LEFT JOIN query|allergy|pathological/);
                return [{ person: { id_person: 'patient-a', name: 'QA', telephone: '1234567890' }, address: { direction: 'QA' } }];
            }
            return [{ person: { id_person: 'patient-a', id_signature: 'clinical-signature' }, query: { current_condition: 'private' }, address: {}, social_media: '{}' }];
        }
        return [];
    }
};
stub('db/Sequelize.connection.js', db);
stub('Dao/mysql/patientAllergy.dao.js', { getCurrent: async () => ({ review_status: 'HAS_ALLERGIES', description: 'private' }), update: async () => ({ status: 200 }) });
stub('services/aws/s3.js', { uploadFile: async () => { throw new Error('Unexpected file upload'); }, getBucketbyCode: () => 'qa' });
const dao = require('../../src/Dao/mysql/px.dao');
const filesDao = require('../../src/Dao/mysql/file.Dao');
const validators = require('../../src/validators/px.validator');
const payload = { id_business: 'tenant-a', id_login: 'reception', person: { id_person: 'patient-a', name: 'QA', surname: 'Test', birthday: '2000-01-01', age: 26, telephone: '1234567890' }, address: { id_address: 'victim-address', direction: 'QA', residence: '', cp: '', place_birth: '' }, query: { id_query: 'victim-query', current_condition: 'injection' }, allergy: { description: 'injection' }, files: { file: 'injection' } };

(async () => {
    assert.equal(validators.validatePxAdministrative({ body: payload }).isValid, true);
    assert.equal(validators.validatePxAdministrative({ body: { ...payload, person: { ...payload.person, birthday: '2026-02-31' } } }).isValid, false);
    const admin = await dao.getPxById('patient-a', 'tenant-a');
    assert.equal(admin.status, 200);
    assert.deepEqual(Object.keys(admin.data).sort(), ['access', 'address', 'person']);
    assert.equal(admin.data.access.clinical, false);
    assert.equal(calls.length, 1, 'Administrative projection never loads clinical tables');
    mode = 'clinical'; calls = [];
    const clinical = await dao.getPxById('patient-a', 'tenant-a', { clinical: true });
    assert.equal(clinical.data.access.clinical, true);
    assert.equal(clinical.data.query.current_condition, 'private');
    assert.equal(clinical.data.allergy.description, 'private');
    assert.equal(clinical.data.pathological_data.length, 1);

    calls = []; assert.equal((await dao.updateAdministrative(payload)).status, 200);
    assert.equal(committed, 1);
    const writes = calls.filter(call => /^(UPDATE|INSERT)/.test(call.sql));
    assert.equal(writes.length, 2);
    for (const { sql, options } of writes) {
        assert.match(sql, /(?:UPDATE person|UPDATE address)/);
        assert.equal(options.replacements.patient, 'patient-a');
        assert.equal(options.replacements.business, 'tenant-a');
        assert.doesNotMatch(sql, /query|allergy|signature|pathological|active\s*=/);
        assert.equal(JSON.stringify(options.replacements).includes('victim'), false);
    }
    calls = []; tenantFound = false;
    assert.equal((await dao.updateAdministrative(payload)).status, 404);
    assert.equal(calls.filter(call => /^(UPDATE|INSERT)/.test(call.sql)).length, 0);
    assert.equal((await filesDao.uploadFile(payload)).status, 404, 'Reject foreign patient before S3');
    assert.equal((await filesDao.uploaProfilePhoto(payload)).status, 404);
    tenantFound = true; childFound = false; calls = [];
    assert.equal((await dao.pxUpdate(payload)).status, 403, 'Clinical form cannot swap child ids');
    assert.equal(calls.some(call => /CALL |^UPDATE/.test(call.sql)), false);
    childFound = true; calls = [];
    assert.equal((await dao.pxForceDelete('patient-a', 'tenant-a')).status, 403);
    assert.equal(calls.length, 0, 'No query at all for permanent deletion');
    assert.equal((await dao.pxDelete('patient-a', 'user', 'tenant-a')).data.active, 0);
    assert.equal((await dao.setArchived('patient-a', 'user', 'tenant-a', false)).data.active, 1);
    assert.equal(calls.filter(call => /^UPDATE person/.test(call.sql)).length, 2);

    let permissions = [], reached = [];
    const hasPermission = async (_user, permission) => permissions.includes(permission);
    stub('util/effectivePermissions.js', { hasPermission });
    stub('Dao/mysql/user.dao.js', { hasPermission });
    stub('Dao/mysql/session.Dao.js', { checkActiveSession: async () => true });
    stub('auth/authenticate.js', { Auth: (req, _res, next) => { req.tokenDecode = { id_login: 'actor', id_session: 'qa-session', id_business: 'tenant-a', rol: 'assistant' }; next(); } });
    stub('middleware/requireTenantOperational.middleware.js', (_req, _res, next) => next());
    stub('middleware/csrf.middleware.js', { csrfProtection: () => (_req, _res, next) => next() });
    stub('services/security/securityLogger.service.js', { record() {} });
    for (const method of ['pxCreateMinimal', 'pxSave', 'pxUpdate', 'updateAdministrative', 'getPxSearch', 'pxDelete', 'setArchived']) dao[method] = async (...args) => { reached.push({ method, args }); return { status: 200, data: {} }; };
    dao.getPxById = async (_patient, _business, options) => ({ status: 200, data: { access: options } });
    filesDao.getfiles = async (_patient, _business, options) => ({ status: 200, data: { codes: options.codes } });
    filesDao.deleteFile = async () => ({ status: 200, data: {} });
    const app = express(); app.use(express.json()); app.use('/px', require('../../src/routes/mysql/px')); app.use('/api/file', require('../../src/routes/mysql/file'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const request = async (url, method = 'GET', body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, body: await response.json() };
    };
    try {
        permissions = ['px.all', 'px.new'];
        const projection = await request('/px/get/patient-a?clinical=true'); assert.equal(projection.body.data.access.clinical, false);
        assert.equal((await request('/px/create-minimal', 'POST', payload)).status, 200);
        assert.equal((await request('/px/administrative', 'PUT', payload)).status, 200);
        for (const [url, method] of [['/px/save', 'POST'], ['/px/update', 'PUT'], ['/px/allergies', 'PUT'], ['/api/file/px/upload-file', 'POST'], ['/api/file/delete', 'DELETE']]) assert.equal((await request(url, method, payload)).status, 403, url);
        assert.equal((await request('/api/file/px/file/patient-a')).status, 403);
        assert.equal((await request('/px/force-delete', 'DELETE', { id_person: 'patient-a' })).status, 403);
        assert.equal((await request('/px/delete', 'DELETE', { id_person: 'patient-a' })).status, 200);
        assert.equal((await request('/px/restore', 'PUT', { id_person: 'patient-a' })).status, 200);
        assert.equal((await request('/px/search', 'POST', { param: '', include_archived: true })).status, 200);
        assert.equal(reached.at(-1).args[2].includeArchived, true);
        permissions = ['px.all'];
        await request('/px/search', 'POST', { param: '', include_archived: true });
        assert.equal(reached.at(-1).args[2].includeArchived, false);
        assert.equal((await request('/px/administrative', 'PUT', payload)).status, 403);
        assert.equal((await request('/px/delete', 'DELETE', { id_person: 'patient-a' })).status, 403);
        permissions = [];
        assert.equal((await request('/px/get/patient-a')).status, 403);
        permissions = ['px.tab.photos'];
        assert.deepEqual((await request('/api/file/px/file/patient-a')).body.data.codes, ['C4CA42']);
        assert.equal((await request('/api/file/delete', 'DELETE', { id_person: 'patient-a', code_cat_files: 'C4CA42', key: 'qa' })).status, 403, 'Photo reading does not grant writing');
        permissions = ['px.radiography'];
        assert.deepEqual((await request('/api/file/px/file/patient-a')).body.data.codes, ['C81E72']);
        permissions = ['px.photos.manager'];
        assert.deepEqual((await request('/api/file/px/file/patient-a')).body.data.codes, ['C4CA42', 'C81E72']);
        assert.equal((await request('/api/file/delete', 'DELETE', { id_person: 'patient-a', code_cat_files: 'CFCD20', key: 'qa' })).status, 403, 'Image management cannot access legacy signatures');
        assert.equal((await request('/api/file/delete', 'DELETE', { id_person: 'patient-a', code_cat_files: 'C4CA42', key: 'qa' })).status, 200);
        permissions = ['px.all', 'px.new', 'clinical_history.view', 'clinical_history.edit_draft'];
        assert.equal((await request('/px/get/patient-a')).body.data.access.clinical, true);
        assert.equal((await request('/px/allergies', 'PUT', {})).status, 200);
        assert.equal((await request('/px/force-delete', 'DELETE', { id_person: 'patient-a' })).status, 403);
    } finally { await new Promise(resolve => server.close(resolve)); }
    console.log('PASS S16 patient: administrative/clinical projections, scoped allowlist edits, forged child ids, tenant rejection before S3, archive/restore without DELETE, real HTTP route permissions and legacy endpoint denial. Mock database; no clinical data changed.');
})().catch(error => { console.error(error); process.exitCode = 1; });

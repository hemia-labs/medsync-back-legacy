'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
process.env.MAX_IMAGE_UPLOAD_BYTES = String(64 * 1024);
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const { decodeImage, maxImageBytes } = require('../../src/util/file/image');
const image = Buffer.from('synthetic raster payload');
const dataUrl = 'data:image/png;base64,' + image.toString('base64');
let sdkCalls = [], sqlCalls = [], events = [], deleteKeys = [], owns = true, uploadFails = false, sqlFails = false, sqlCode = 0, sqlEmpty = false, deleteFails = false, active = 0, peak = 0;
const config = { AWS_REGION: 'us-east-2', BUCKETS: { PHOTOS: 'qa-photo', PROFILE: 'qa-profile', FIRMAS: 'qa-signature', CONFIGFIRMS: 'qa-config' } };
stub('../../src/config/config', config);
stub('aws-sdk', { S3: class {
    upload(params) {
        sdkCalls.push(params); events.push('upload'); active++; peak = Math.max(peak, active);
        return { promise: async () => {
            try { await new Promise(resolve => setImmediate(resolve)); if (uploadFails) throw new Error('Synthetic S3 failure');
                return { Location: 'https://synthetic.invalid/' + params.Key, Key: params.Key, key: params.Key }; }
            finally { active--; }
        } };
    }
    deleteObject(params) { events.push('delete'); deleteKeys.push(params.Key); return { promise: async () => { if (deleteFails) throw new Error('Synthetic delete failure'); return {}; } }; }
} });
stub('../../src/db/Sequelize.connection', {
    async transaction() { return { async commit() {}, async rollback() {} }; },
    async query(sql, options = {}) {
        sqlCalls.push({ sql, options });
        if (/^\s*CALL/i.test(sql) || /^\s*INSERT/i.test(sql)) {
            events.push('save'); if (sqlFails) throw new Error('Synthetic SQL failure');
            if (sqlEmpty) return [];
            if (sql.includes('SP_signature_consent_Update') && !sqlCode) return [{ id_signature_consent: 'consent', id_business: 'tenant', key_signature: options.replacements._key_signature }];
            return [{ Code: sqlCode }];
        }
        if (sql.includes('SELECT key_signature FROM signature_consent')) return owns ? [{ key_signature: 'previous' }] : [];
        if (sql.includes('SELECT COUNT(*) AS total FROM person')) return [{ total: 1 }];
        if (sql.includes('SELECT id_person FROM person')) return owns ? [{ id_person: 'patient' }] : [];
        return [];
    }
});
const service = require('../../src/services/aws/s3');
const files = require('../../src/Dao/mysql/file.Dao');
const configuration = require('../../src/Dao/mysql/config.dao');
const patients = require('../../src/Dao/mysql/px.dao');
const originalIo = Object.fromEntries(['writeFileSync', 'unlinkSync', 'createReadStream'].map(key => [key, fs[key]]));
const payload = () => ({ id_person: 'patient', id_login: 'actor', id_business: 'tenant', code_cat_files: 'C4CA42', file: dataUrl });
function reset() { sdkCalls = []; sqlCalls = []; events = []; deleteKeys = []; owns = true; uploadFails = false; sqlFails = false; sqlCode = 0; sqlEmpty = false; deleteFails = false; }
(async () => {
    const decoded = decodeImage(dataUrl);
    assert.deepEqual(decoded.body, image); assert.equal(decoded.contentType, 'image/png');
    assert.match(decoded.key, /^[0-9a-f-]{36}\.png$/);
    assert.equal(decodeImage(dataUrl.replace('image/png', 'image/jpeg')).contentType, 'image/jpeg');
    assert.ok(decodeImage('data:image/webp;base64,' + Buffer.alloc(maxImageBytes).toString('base64')));
    const tooLarge = 'data:image/png;base64,' + Buffer.alloc(maxImageBytes + 1).toString('base64');
    const originalFrom = Buffer.from; let allocations = 0;
    try { Buffer.from = (...args) => { allocations++; return originalFrom(...args); }; assert.equal(decodeImage(tooLarge), null); }
    finally { Buffer.from = originalFrom; }
    assert.equal(allocations, 0, 'Oversize rejected before allocating decoded bytes');
    for (const invalid of [null, '', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,A',
        'data:image/png;base64,%%%%', 'data:image/png;base64,AA=A', 'data:image/png;base64,AAA===']) assert.equal(decodeImage(invalid), null);
    for (const key of Object.keys(originalIo)) fs[key] = () => { throw new Error('Unexpected temp-file I/O: ' + key); };
    reset();
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => files.uploadFile(payload())));
    assert.ok(concurrent.every(response => response.status === 200));
    assert.equal(new Set(sdkCalls.map(call => call.Key)).size, 5);
    assert.ok(sdkCalls.every(call => Buffer.isBuffer(call.Body) && call.Body.equals(image) && call.ContentType === 'image/png'));
    assert.equal(peak, 5, 'Uploads yield asynchronously and overlap without temp-file operations');
    reset(); assert.equal((await files.uploaProfilePhoto(payload())).status, 200);
    assert.equal(sdkCalls[0].Bucket, 'qa-profile');
    reset(); owns = false;
    assert.equal((await files.uploadFile(payload())).status, 404);
    assert.equal((await files.uploaProfilePhoto(payload())).status, 404);
    assert.equal(sdkCalls.length, 0, 'Foreign patient fails before allocation/upload');
    reset(); assert.equal((await files.uploadFile({ ...payload(), file: tooLarge })).status, 500);
    assert.equal(sdkCalls.length, 0);
    reset(); uploadFails = true;
    assert.equal((await files.uploadFile(payload())).status, 500);
    assert.ok(!events.includes('save'), 'S3 failure never records a URL');
    reset(); sqlFails = true;
    assert.equal((await files.uploaProfilePhoto(payload())).status, 500);
    reset();
    assert.equal((await configuration.signature_content_save({ id_login: 'actor', id_business: 'tenant', files: { file: dataUrl } })).status, 200);
    assert.equal(sdkCalls[0].Bucket, 'qa-config');
    const replacement = () => ({ id_signature_consent: 'consent', key_signature: 'previous', url_signature: '', id_login: 'actor', id_business: 'tenant', files: { file: dataUrl } });
    reset(); uploadFails = true;
    assert.equal((await configuration.signature_content_update(replacement())).status, 500);
    assert.ok(!events.includes('delete'), 'Existing signature survives failed replacement upload');
    reset(); sqlFails = true;
    assert.equal((await configuration.signature_content_update(replacement())).status, 500);
    assert.ok(!events.includes('delete'), 'Existing signature survives failed SQL save');
    reset(); sqlCode = 1100;
    assert.notEqual((await configuration.signature_content_update(replacement())).status, 200);
    assert.ok(!events.includes('delete'), 'Procedure-level rejection preserves previous signature');
    reset(); sqlEmpty = true;
    assert.notEqual((await configuration.signature_content_update(replacement())).status, 200);
    assert.ok(!events.includes('delete'), 'No saved row, no deletion of the previous object');
    reset(); owns = false;
    assert.equal((await configuration.signature_content_update(replacement())).status, 404);
    assert.equal(sdkCalls.length, 0, 'Foreign/missing consent fails before upload');
    reset();
    assert.equal((await configuration.signature_content_update({ ...replacement(), key_signature: 'forged-client-key' })).status, 200);
    assert.deepEqual(events, ['upload', 'save', 'delete']);
    assert.deepEqual(deleteKeys, ['previous'], 'Deletion uses the server-owned previous key, never a client-supplied key');
    reset(); deleteFails = true;
    const originalWarn = console.warn; const warnings = [];
    try { console.warn = message => warnings.push(message); assert.equal((await configuration.signature_content_update(replacement())).status, 200); }
    finally { console.warn = originalWarn; }
    assert.equal(warnings.length, 1); assert.ok(!warnings[0].includes('previous'));
    const patient = () => ({ id_login: 'actor', id_business: 'tenant', files: { file: dataUrl },
        person: { id_person: 'patient', name: 'Synthetic', surname: 'Patient', birthday: '01-01-2000', age: 26 },
        address: {}, query: {}, allergy: { review_status: 'UNREVIEWED' } });
    reset(); assert.equal((await patients.pxSave(patient())).status, 200);
    assert.equal(sdkCalls[0].Bucket, 'qa-signature');
    assert.ok(sqlCalls.some(call => call.sql.includes('INSERT INTO person') && call.options.replacements._id_signature.startsWith('https://synthetic.invalid/')));
    reset(); assert.equal((await patients.pxUpdate(patient())).status, 200);
    assert.equal(sdkCalls[0].Bucket, 'qa-signature');
    reset(); owns = false;
    assert.equal((await patients.pxUpdate(patient())).status, 404); assert.equal(sdkCalls.length, 0);
    await assert.rejects(service.uploadImage('qa-photo', 'data:image/png;base64,%%%%'));
    const imagePath = require.resolve('../../src/util/file/image');
    process.env.MAX_IMAGE_UPLOAD_BYTES = '0'; delete require.cache[imagePath];
    assert.equal(require(imagePath).decodeImage(dataUrl), null, 'Configured zero keeps uploads disabled');
    process.env.MAX_IMAGE_UPLOAD_BYTES = 'invalid'; delete require.cache[imagePath];
    assert.equal(require(imagePath).maxImageBytes, 5 * 1024 * 1024, 'Invalid configuration never removes the size limit');
    console.log(JSON.stringify({ result: 'PASS', concurrentUploads: 5, peakMockSdkUploads: peak,
        temporaryFileOperations: 0, oversizeDecodedAllocations: allocations,
        formatsOwnershipFailuresAndReplacement: 'PASS', services: 'S3/SQL simulated; no external calls' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    for (const [key, operation] of Object.entries(originalIo)) fs[key] = operation;
});

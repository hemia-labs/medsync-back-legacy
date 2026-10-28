'use strict';
const { deleteFile } = require('./s3');
const { recordUploadCleanup } = require('../recoveryJournal');

async function queueUploadCleanup(bucket, object, reason = 'persistence_failed') {
    if (object && object.Key) {
        // Private recovery journal. Never log image contents, bearer URLs or PHI.
        // Operations must verify absence of a DB reference before retrying deletion.
        await recordUploadCleanup({ bucket, key: object.Key, reason });
        console.warn('[STORAGE_CLEANUP_PENDING]');
    }
}
async function compensateUpload(bucket, object) {
    if (!object || !object.Key) return;
    try { await deleteFile(bucket, object.Key); }
    catch (_) { await queueUploadCleanup(bucket, object); }
}
module.exports = { compensateUpload, queueUploadCleanup };

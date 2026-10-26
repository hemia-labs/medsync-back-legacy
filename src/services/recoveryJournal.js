'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Only operational identifiers belong here; never pass bearer URLs or content.
async function recordSignatureEmailAudit({ requestId, businessId, actorId, provider, messageId }) {
    const dir = path.resolve('logs');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(dir, 'signature-email-audit-pending.jsonl'), JSON.stringify({
        requestId, businessId, actorId, provider, messageId, acceptedAt: new Date().toISOString()
    }) + '\n', { mode: 0o600 });
}
async function recordUploadCleanup({ bucket, key, reason }) {
    const dir = path.resolve('logs');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(dir, 'storage-cleanup-pending.jsonl'), JSON.stringify({
        bucket, key, reason, createdAt: new Date().toISOString()
    }) + '\n', { mode: 0o600 });
}
module.exports = { recordSignatureEmailAudit, recordUploadCleanup };

'use strict';
const crypto = require('node:crypto');
function cursorCodec(secret, now = Date.now) {
    const key = crypto.createHash('sha256').update('medsync-pulse-cursor-v1\0').update(String(secret)).digest();
    return {
        encode(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(JSON.stringify({ ...value, expires: now() + 300000 })), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url'); },
        decode(token, context) { try { if (typeof token !== 'string' || token.length > 2048 || !/^[\w-]+$/.test(token)) throw Error(); const b = Buffer.from(token, 'base64url'); if (b.toString('base64url') !== token) throw Error(); const decipher = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); decipher.setAuthTag(b.subarray(12, 28)); const value = JSON.parse(Buffer.concat([decipher.update(b.subarray(28)), decipher.final()])); if (value.expires <= now() || value.business !== context.business || value.revision !== context.revision || value.indicator !== context.indicator || value.rules !== context.rules) throw Error(); return value; } catch (_) { throw Object.assign(Error('PULSE_CURSOR_INVALID'), { status: 400 }); } }
    };
}
module.exports = { cursorCodec };

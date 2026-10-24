'use strict';
const { scrypt, randomBytes, timingSafeEqual, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { RegistrationError } = require('../registration/errors');
const N = 131072, r = 8, p = 1, maxmem = 256 * 1024 * 1024;
let running = false;
const queue = [];

function limited(run) {
    return new Promise((resolve, reject) => {
        if (running && queue.length >= 4) return reject(new RegistrationError('PASSWORD_CAPACITY_BUSY', 503));
        const job = { run, resolve, reject, timer: null };
        if (running) job.timer = setTimeout(() => {
            const index = queue.indexOf(job);
            if (index >= 0) queue.splice(index, 1);
            reject(new RegistrationError('PASSWORD_CAPACITY_BUSY', 503));
        }, 3000);
        queue.push(job); drain();
    });
}
function drain() {
    if (running || !queue.length) return;
    running = true;
    const job = queue.shift(); clearTimeout(job.timer);
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { running = false; drain(); });
}
const derive = (password, salt) => limited(() => new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N, r, p, maxmem }, (error, key) => error ? reject(error) : resolve(key))));

function normalizePassword(password) {
    if (typeof password !== 'string' || !password.isWellFormed()) throw new RegistrationError('PASSWORD_INVALID');
    const value = password.normalize('NFC');
    if ([...value].length < 15 || [...value].length > 128 || Buffer.byteLength(value,'utf8') > 512) throw new RegistrationError('PASSWORD_INVALID');
    return value;
}

// Deployment must supply an approved, versioned local list. Missing configuration
// closes issuance, not verification of an already-issued hash. Never call a web API.
async function configuredBlocklist() {
    const filename = process.env.REGISTRATION_PASSWORD_BLOCKLIST_PATH;
    const digest = process.env.REGISTRATION_PASSWORD_BLOCKLIST_SHA256;
    if (!filename || !/^[a-f0-9]{64}$/.test(digest || '')) throw new RegistrationError('PASSWORD_POLICY_UNAVAILABLE', 503);
    try {
        const stat = await fs.stat(filename);
        if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw Error();
        const bytes = await fs.readFile(filename);
        if (createHash('sha256').update(bytes).digest('hex') !== digest) throw Error();
        const list = JSON.parse(bytes.toString('utf8'));
        if (!list.version || !list.source || !list.license || !Array.isArray(list.passwords) || !list.passwords.length
            || list.passwords.some(word => typeof word !== 'string')) throw Error();
        return new Set(list.passwords.map(word => word.normalize('NFC').toLowerCase()));
    } catch (_) { throw new RegistrationError('PASSWORD_POLICY_UNAVAILABLE', 503); }
}

async function hash(password, loadBlocklist = configuredBlocklist) {
    const value = normalizePassword(password);
    const blocked = await loadBlocklist();
    if (!(blocked instanceof Set) || !blocked.size) throw new RegistrationError('PASSWORD_POLICY_UNAVAILABLE', 503);
    if (blocked.has(value.toLowerCase())) throw new RegistrationError('PASSWORD_COMPROMISED');
    const salt = randomBytes(16);
    const key = await derive(value, salt);
    return `scrypt-v1$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verify(password, encoded) {
    // Exact bounded parser: data in the DB can never request arbitrary KDF cost.
    const match = typeof encoded === 'string' && /^scrypt-v1\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
    if (!match) return false;
    let value;
    try { value = normalizePassword(password); } catch (_) { return false; }
    const derived = await derive(value, Buffer.from(match[1], 'hex'));
    return timingSafeEqual(derived, Buffer.from(match[2], 'hex'));
}
module.exports = { hash, verify, normalizePassword, configuredBlocklist };

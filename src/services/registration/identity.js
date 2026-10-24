'use strict';

// Shared with s24IdentitySchema.js. Keep the SQL/JS parity suite when changing it.
// Legacy writers accept 7-15 digits; public registration will require exactly 10.
function normalizePhone(value) {
    if (typeof value !== 'string') return null;
    let phone = value.replace(/^ +| +$/g, '').replace(/[ ()\-.]/g, '');
    if (/^\+52\d{10}$/.test(phone)) phone = phone.slice(3);
    else if (/^52\d{10}$/.test(phone)) phone = phone.slice(2);
    return /^\d{7,15}$/.test(phone) ? phone : null;
}

function normalizeEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.replace(/^ +| +$/g, '').toLowerCase();
    return email.length <= 254 && /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)
        ? email : null;
}

function inventory(rows) {
    const owners = new Map();
    const report = { accounts: rows.length, inactive: 0, invalid: { phone: 0, email: 0 }, duplicates: { phone: 0, email: 0 } };
    for (const row of rows) {
        if (!Number(row.active)) report.inactive++;
        for (const [kind, value] of [['phone', normalizePhone(row.telephone)], ['email', normalizeEmail(row.email)]]) {
            if (!value) { report.invalid[kind]++; continue; }
            const key = `${kind}:${value}`;
            const previous = owners.get(key);
            if (previous && previous !== row.id_login) report.duplicates[kind]++;
            owners.set(key, row.id_login);
        }
    }
    report.ready = Object.values(report.invalid).every(n => n === 0) && Object.values(report.duplicates).every(n => n === 0);
    return report; // No identities, passwords or account IDs leave the audit.
}

module.exports = { normalizePhone, normalizeEmail, inventory };

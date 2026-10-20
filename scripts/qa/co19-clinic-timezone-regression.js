'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
let admin = true, failUpdate = false, calls = [], transactions = [];
const stub = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const db = {
    async transaction() {
        const transaction = { finished: false, async commit() { this.finished = 'commit'; }, async rollback() { this.finished = 'rollback'; } };
        transactions.push(transaction); return transaction;
    },
    async query(sql, options) {
        calls.push({ sql, ...options });
        if (failUpdate && sql.startsWith('UPDATE')) throw new Error('QA simulated database failure');
        return [];
    }
};
stub('../../src/db/Sequelize.connection', db);
stub('../../src/util/effectivePermissions', { isTenantAdministrator: async (actor, business, permission) => {
    assert.equal(actor, 'actor'); assert.equal(business, 'tenant'); assert.equal(permission, 'admin.config'); return admin;
} });
const dao = require('../../src/Dao/mysql/appointment.Dao');
dao.readConfig = async (business, profile, transaction) => {
    assert.equal(business, 'tenant'); assert.equal(profile, null); assert.equal(transaction, transactions.at(-1));
    return { id: 'general-config', enabled: false, timezone: 'America/Mexico_City', blockedDates: [{ date: '2026-12-25' }] };
};
const body = { id_login: 'actor', id_business: 'tenant', timezone: 'America/Tijuana' };
(async () => {
    admin = false;
    assert.equal((await dao.saveTimezone(body)).status, 403); assert.equal(calls.length, 0);
    admin = true;
    for (const timezone of [undefined, null, '', ' ', 'Invalid/Zone', '+01:00', 123, 'a'.repeat(81)]) {
        assert.equal((await dao.saveTimezone({ ...body, timezone })).status, 400);
    }
    assert.equal(calls.length, 0); assert.equal(transactions.length, 0);
    const response = await dao.saveTimezone({ ...body, enabled: true, blockedDates: [], doctorProfileId: 'other-doctor' });
    assert.equal(response.status, 200); assert.deepEqual(response.data, { timezone: 'America/Tijuana' });
    assert.equal(transactions.at(-1).finished, 'commit');
    assert.match(calls[0].sql, /FROM business.*FOR UPDATE/);
    const update = calls[1];
    assert.match(update.sql, /WHERE id_appointment_config = :config AND id_business = :business AND doctor_profile_id IS NULL AND active = 1/);
    assert.deepEqual(update.replacements, { timezone: 'America/Tijuana', actor: 'actor', config: 'general-config', business: 'tenant' });
    assert.equal(update.transaction, transactions.at(-1));
    assert.equal(calls.length, 2, 'No full configuration save, doctor update or closure write');
    assert.doesNotMatch(update.sql, /enabled\s*=|default_appointment_duration\s*=|DELETE|appointment_blocked|appointment_working/);
    failUpdate = true;
    assert.equal((await dao.saveTimezone(body)).status, 500); assert.equal(transactions.at(-1).finished, 'rollback');

    let submitted;
    dao.saveTimezone = async input => { submitted = input; return { status: 200 }; };
    const controller = require('../../src/controller/mysql/appointment.controller');
    const req = { tokenDecode: { id_login: 'actor', id_business: 'tenant', rol: 'admin' }, body: { id_login: 'forged-actor', id_business: 'forged-tenant', timezone: 'America/Cancun' } };
    await controller.saveTimezone(req, { status(code) { assert.equal(code, 200); return this; }, send() {} });
    assert.equal(submitted.id_login, 'actor'); assert.equal(submitted.id_business, 'tenant');
    const routes = fs.readFileSync(require.resolve('../../src/routes/mysql/appointment'), 'utf8');
    assert.match(routes, /router\.post\('\/config\/timezone', Token\.Auth, csrfProtected, requireTenantOperational, requireAnyPermission\(\['admin.config'\]/);
    console.log('PASS CO19 timezone API: admin authorization, tenant from token, strict zone validation, business lock, targeted general update, rollback and auth/CSRF route guards. No real DB writes.');
})().catch(error => { console.error(error); process.exitCode = 1; });

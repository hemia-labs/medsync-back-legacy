'use strict';
// NC1-EC1 / EC1-R1: an invalid emergency contact must reach the client as
// HTTP 400 with EMERGENCY_CONTACT_INVALID and the field, and nothing is written.
// Synthetic data only, no database: the DAO write is replaced by a spy.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const router = require('../../src/routes/mysql/px.js');
const PxDao = require('../../src/Dao/mysql/px.dao');

const route = router.stack.find(layer => layer.route && layer.route.path === '/administrative' && layer.route.methods.put).route;
const names = route.stack.map(layer => layer.name);

const birthday = '2000-01-01';
const age = new Date().getFullYear() - 2000; // birthday on 1 January: already reached every day of the year
const body = (extra = {}) => ({
    person: { id_person: 'synthetic-person', name: 'Paciente', surname: 'Ficticio', birthday, age, telephone: '5500000061' },
    address: {},
    ...extra
});

async function withServer(run) {
    // Real route layers after authentication, CSRF, tenant and permission (covered by their own suites).
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.tokenDecode = { id_login: 'synthetic-login', id_business: 'synthetic-business', rol: 'doctor' }; next(); });
    app.put('/api/px/administrative', ...route.stack.slice(4).map(layer => layer.handle));
    const original = PxDao.updateAdministrative;
    const writes = [];
    PxDao.updateAdministrative = async payload => { writes.push(payload); return { status: 200, data: null, message: 'ok' }; };
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const put = async payload => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/px/administrative`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
            });
            return { status: response.status, json: await response.json() };
        };
        await run(put, writes);
    } finally {
        PxDao.updateAdministrative = original;
        await new Promise(resolve => server.close(resolve));
    }
}

test('route keeps the security layers first, then validation, then the controller', () => {
    assert.equal(names.length, 6, JSON.stringify(names));
    assert.deepEqual(names.slice(2, 4), ['requireTenantOperational', 'requirePermissionMiddleware']);
});

test('HTTP 400 keeps EMERGENCY_CONTACT_INVALID and field, and does not write', async () => {
    await withServer(async (put, writes) => {
        for (const [contact, field] of [
            [{ name: 'Contacto QA', email: 'qa@example.invalid' }, 'emergencyContact.email'],
            [{ name: 'Contacto QA', phone: '12' }, 'emergencyContact.phone'],
            [{ name: '   ' }, 'emergencyContact.name'],
            [[], 'emergencyContact.value']
        ]) {
            const { status, json } = await put(body({ emergencyContact: contact }));
            assert.equal(status, 400, JSON.stringify(contact));
            assert.equal(json.status, 400);
            assert.deepEqual(json.data, { code: 'EMERGENCY_CONTACT_INVALID', field });
            assert.match(json.message, /contacto de emergencia/);
        }
        assert.equal(writes.length, 0, 'invalid contact must not reach the DAO');
    });
});

test('other validation errors keep the historical 400 shape; valid payloads reach the DAO', async () => {
    await withServer(async (put, writes) => {
        const missing = await put({ address: {} });
        assert.equal(missing.status, 400);
        assert.equal(missing.json.data, '');
        assert.equal(writes.length, 0);
        const ok = await put(body({ emergencyContact: { name: 'Contacto QA', phone: '55.1111.2222' } }));
        assert.equal(ok.status, 200);
        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0].emergencyContact, { name: 'Contacto QA', phone: '55.1111.2222' });
        assert.equal(writes[0].id_business, 'synthetic-business');
    });
});

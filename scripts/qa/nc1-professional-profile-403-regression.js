'use strict';
// NC1 P2 (review §7.1): viewing or editing someone else's professional profile without admin.users
// answered 401. The client treats 401 as a lost session and ends a valid one. Contract:
//   - valid session without permission: 403 PERMISSION_DENIED, nothing read or written;
//   - self and administrator access unchanged; business isolation unchanged;
//   - Token.Auth keeps its 401 AUTH_* answers.
// Reachable path: requireSelfOrPermission accepts a request as "self" when body.target_id_login is the
// actor, while the controller targets params.id; the DAO is then the effective gate.
// Real UserDao, permission middleware and Token.Auth; simulated database with synthetic rows only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

const logins = {
    'qa-doctor': { id_login: 'qa-doctor', id_business: 'qa-clinic', rol: 'doctor' },
    'qa-other-doctor': { id_login: 'qa-other-doctor', id_business: 'qa-clinic', rol: 'doctor' },
    'qa-foreign-doctor': { id_login: 'qa-foreign-doctor', id_business: 'qa-other-clinic', rol: 'doctor' }
};
const profiles = Object.fromEntries(Object.values(logins).map(l => [l.id_login, { id_doctor_professional_profile: 'qa-pp-' + l.id_login, id_login: l.id_login, id_business: l.id_business, professional_name: 'QA ' + l.id_login, rol: l.rol }]));
let queries = [], transactions = 0, rollbacks = 0, commits = 0;
const db = {
    async transaction() {
        transactions++;
        return { finished: false, async commit() { commits++; this.finished = true; }, async rollback() { rollbacks++; this.finished = true; } };
    },
    async query(sql, options = {}) {
        queries.push(sql);
        const r = options.replacements || {};
        if (/FROM business WHERE id_business = :business FOR UPDATE/.test(sql)) return ['qa-clinic', 'qa-other-clinic'].includes(r.business) ? [{ id_business: r.business }] : [];
        // NC1 identidad integrada: the profile read also loads its identity (none stored for these rows).
        if (/FROM doctor_professional_profile WHERE id_doctor_professional_profile=:id AND id_business=:business/.test(sql)) {
            const row = Object.values(profiles).find(p => p.id_doctor_professional_profile === r.id && p.id_business === r.business);
            return row ? [{ ...row }] : [];
        }
        if (/FROM professional_identity/.test(sql)) return [];
        if (/FROM doctor_professional_profile dpp/.test(sql)) {
            const row = profiles[r._id_login];
            return row && row.id_business === r._id_business ? [{ ...row }] : [];
        }
        // Existing, active profiles: an authorized save updates them without a license activation.
        if (/FROM doctor_professional_profile\s+WHERE id_login/.test(sql)) {
            const row = profiles[r._id_login];
            return row && row.id_business === r._id_business ? [{ id_doctor_professional_profile: 'qa-pp-' + row.id_login }] : [];
        }
        if (/FROM doctor_professional_profile\s+WHERE id_doctor_professional_profile/.test(sql)) {
            return [{ can_issue_prescriptions: 1, can_sign_documents: 1, is_active: 1, professional_name: 'QA Perfil', professional_license: null,
                university: null, specialty: null, specialty_license: null, professional_phone: null, signature_image: null }];
        }
        if (/FROM login l/.test(sql) && /l\.active = 1/.test(sql)) {
            const row = logins[r._id_login];
            return row && row.id_business === r._id_business ? [{ ...row }] : [];
        }
        return [];
    }
};
const dbPath = require.resolve('../../src/db/Sequelize.connection');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
const UserDao = require('../../src/Dao/mysql/user.dao');
let admins = new Set();
UserDao.hasPermission = async (login, permission) => permission === 'admin.users' && admins.has(login);

const results = [];
const reset = () => { queries = []; transactions = 0; rollbacks = 0; commits = 0; admins = new Set(); };
const test = async (name, fn) => { reset(); await fn(); results.push(name); console.log('PASS ' + name); };
const writes = () => queries.filter(sql => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql));
const denied = (response, label) => {
    assert.notEqual(response.status, 401, `${label}: a 401 ends a valid client session`);
    assert.equal(response.status, 403, label);
    assert.equal(response.data && response.data.code, 'PERMISSION_DENIED', label);
};
const saveBody = extra => ({ id_login: 'qa-doctor', id_business: 'qa-clinic', professional_name: 'QA Perfil', ...extra });

(async () => {
    await test('viewing another profile without admin.users is 403 and reads nothing', async () => {
        denied(await UserDao.getProfessionalProfile('qa-other-doctor', 'qa-clinic', 'qa-doctor'), 'view other profile');
        assert.equal(queries.length, 0, 'The profile is not read');
    });

    await test('own profile and administrator access keep working', async () => {
        const own = await UserDao.getProfessionalProfile('qa-doctor', 'qa-clinic', 'qa-doctor');
        assert.equal(own.status, 200);
        assert.equal(own.data.id_login, 'qa-doctor');
        admins.add('qa-doctor');
        const managed = await UserDao.getProfessionalProfile('qa-other-doctor', 'qa-clinic', 'qa-doctor');
        assert.equal(managed.status, 200);
        assert.equal(managed.data.id_login, 'qa-other-doctor');
    });

    await test('an administrator never reads a profile from another business', async () => {
        admins.add('qa-doctor');
        const foreign = await UserDao.getProfessionalProfile('qa-foreign-doctor', 'qa-clinic', 'qa-doctor');
        assert.equal(foreign.status, 200, 'Unchanged contract: an empty answer, not an error');
        assert.equal(foreign.data, null, 'No row from the other business');
    });

    await test('editing another profile without admin.users is 403 with no transaction or write', async () => {
        denied(await UserDao.saveProfessionalProfile(saveBody({ target_id_login: 'qa-other-doctor' })), 'edit other profile');
        assert.equal(transactions, 0, 'No license transaction is opened');
        assert.equal(queries.length, 0);
        assert.equal(writes().length, 0);
    });

    await test('self edit and administrator edit still save; foreign business stays rejected without writes', async () => {
        // Simulated save: the profile row is written and committed (no real database).
        const self = await UserDao.saveProfessionalProfile(saveBody({ target_id_login: 'qa-doctor', professional_name: '' }));
        assert.equal(self.status, 200, 'Self edit saves: ' + self.message);
        assert.equal(commits, 1);
        assert.ok(writes().length > 0);
        reset();
        admins.add('qa-doctor');
        const managed = await UserDao.saveProfessionalProfile(saveBody({ target_id_login: 'qa-other-doctor', professional_name: '' }));
        assert.equal(managed.status, 200, 'Administrator edit of a same-business profile saves');
        assert.equal(commits, 1);
        assert.ok(writes().length > 0);
        reset();
        admins.add('qa-doctor');
        const foreign = await UserDao.saveProfessionalProfile(saveBody({ target_id_login: 'qa-foreign-doctor' }));
        assert.equal(foreign.status, 400, 'Unchanged contract: a user of another business is invalid for this business');
        assert.equal(rollbacks, 1);
        assert.equal(commits, 0);
        assert.equal(writes().length, 0);
    });

    await test('reachable path: middleware passes as "self" via body, the DAO denies with 403', async () => {
        const { requireSelfOrPermission } = require('../../src/middleware/requirePermission.middleware');
        const gate = requireSelfOrPermission('admin.users', { resource: 'user.professional_profile.save' });
        const req = { tokenDecode: { id_login: 'qa-doctor', id_business: 'qa-clinic' }, params: { id: 'qa-other-doctor' }, body: { target_id_login: 'qa-doctor' }, query: {} };
        let passed = false;
        await gate(req, { status() { return this; }, send() {} }, () => { passed = true; });
        assert.equal(passed, true, 'The route gate lets it through');
        // Same targeting as UserController.saveProfessionalProfile: params.id wins.
        const target = req.params.id || req.body.target_id_login;
        denied(await UserDao.saveProfessionalProfile(saveBody({ target_id_login: target })), 'DAO gate');
        assert.equal(transactions, 0);
    });

    await test('no permission denial in user.dao answers 401', async () => {
        const source = fs.readFileSync(nodePath.join(__dirname, '../../src/Dao/mysql/user.dao.js'), 'utf8');
        assert.ok(!/responseData\.unauthorized\(/.test(source), 'user.dao must not answer 401; authentication belongs to Token.Auth');
    });

    await test('authentication failures keep their 401 contract', async () => {
        const jwt = require('jsonwebtoken');
        const configjwt = require('../../src/config/jwt');
        const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
        let principal = null;
        stub('../../src/config/authCookie.config', { getAuthCookieConfig: () => ({ isCookieAuthEnabled: false }) });
        stub('../../src/auth/activePrincipal', async () => principal);
        stub('../../src/auth/pendingActivation', { enforcePendingActivation: () => false });
        delete require.cache[require.resolve('../../src/auth/authenticate')];
        const Token = require('../../src/auth/authenticate');
        const run = token => new Promise(resolve => {
            const req = { method: 'GET', url: '/', headers: token ? { authorization: 'Bearer ' + token } : {}, cookies: {} };
            const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, send(payload) { resolve({ status: this.statusCode, payload }); } };
            Token.Auth(req, res, () => resolve({ status: 'next' }));
        });
        const sign = (payload, key = configjwt.key) => jwt.sign(payload, key, { algorithm: 'HS256' });
        const expect = async (token, code) => { const r = await run(token); assert.equal(r.status, 401); assert.equal(r.payload.data.code, code); };
        await expect(null, 'AUTH_ACCESS_INVALID');
        await expect(sign({ id_login: 'qa' }, 'not-the-key'), 'AUTH_ACCESS_INVALID');
        await expect(sign({ id_login: 'qa', exp: Math.floor(Date.now() / 1000) - 60 }), 'AUTH_ACCESS_EXPIRED');
        await expect(sign({ id_login: 'qa' }), 'AUTH_SESSION_INVALID');
        principal = { id_login: 'qa', id_business: 'qa-clinic' };
        assert.equal((await run(sign({ id_login: 'qa' }))).status, 'next');
    });

    console.log(`PASS: ${results.length} NC1 professional-profile groups. Synthetic rows only; no database or network.`);
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// NC1 identidad simple — users: migration and flows on an isolated MySQL (nc1-identity.docker.sh container).
// Real migration, real user.dao and registration provisioning; synthetic rows only. Covers:
//   - migration: audit, apply (backup of the table definition), reentrant re-apply, reversal that backs up values;
//   - application before the migration: users are created/edited with last_name only, nothing breaks;
//   - after the migration: separate surnames stored, last_name/name derived, explicit clearing, compound names,
//     older clients (changed last_name drops the structured surnames), existing accounts never split;
//   - registration provisioning writes the surnames of the administrator account.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const mysql = require('mysql2/promise'), { Sequelize } = require('sequelize');

test('NC1 login surnames: migration, users and registration on MySQL', { skip: process.env.NC1_ISOLATED_QA !== '1' }, async () => {
    const database = 'nc1_qa_login_surnames_' + Date.now();
    const conn = await mysql.createConnection({ host: '127.0.0.1', port: 33381, user: 'root', password: 'nc1-synthetic-only' });
    const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'nc1-login-surnames-'));
    let db;
    try {
        await conn.query('CREATE DATABASE ' + database); await conn.changeUser({ database });
        await conn.query(`CREATE TABLE login (id_login VARCHAR(50) PRIMARY KEY, id_business VARCHAR(50), id_rol VARCHAR(50), name VARCHAR(500), first_name VARCHAR(500) NOT NULL DEFAULT '', last_name VARCHAR(500) NOT NULL DEFAULT '',
            email VARCHAR(100), telephone VARCHAR(50), password VARCHAR(200), active INT, locked INT, created_at DATETIME, created_by VARCHAR(50), updated_at DATETIME, updated_by VARCHAR(50)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await conn.query('CREATE TABLE rol (id_rol VARCHAR(50), code VARCHAR(50), active INT) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await conn.query("INSERT INTO rol VALUES ('r-assistant','assistant',1)");
        await conn.query("INSERT INTO login (id_login,id_business,id_rol,name,first_name,last_name,email,telephone,active,locked) VALUES ('legacy','qa','r-assistant','Nombre Antiguo De La Cuenta','Nombre','Antiguo De La Cuenta','legacy@example.invalid','5500000001',1,0)");

        db = new Sequelize(database, 'root', 'nc1-synthetic-only', { host: '127.0.0.1', port: 33381, dialect: 'mysql', logging: false, pool: { max: 1, min: 0 } });
        const stub = (p, exports) => { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports }; };
        stub('../../src/db/Sequelize.connection', db);
        stub('../../src/util/licenseMutation', { beginLicenseMutation: () => db.transaction() });
        stub('../../src/util/effectivePermissions', { hasPermission: async () => true, isTenantAdministrator: async () => true });
        stub('../../src/util/tracingPermissions', { seedTracingPermissions: async () => {} });
        stub('../../src/util/dashboardAccess', { seedDashboardPermissions: async () => {} });
        stub('../../src/util/licenseLimits', { classifyLicenseResource: () => 'auxiliaryUsers', validateLicenseForNewUser: async () => ({ allowed: true }), validateLicenseForProfessionalProfile: async () => ({ allowed: true }), validateLicenseTransition: async () => ({ allowed: true }) });
        // Real module (constants and helpers) with the two lookups pointed at this minimal schema.
        const licenseUsage = require('../../src/Dao/mysql/licenseUsage.dao');
        Object.assign(licenseUsage, {
            getLicenseUserState: async (business, login, transaction) => (await db.query(`SELECT l.id_login,l.id_business,l.id_rol,l.name,l.first_name,l.last_name,l.email,l.telephone,l.active,r.code AS roleCode,0 AS hasActiveProfessionalProfile
                FROM login l LEFT JOIN rol r ON r.id_rol=l.id_rol WHERE l.id_login=:login AND (:business IS NULL OR l.id_business=:business)`, { replacements: { login, business }, type: 'SELECT', transaction }))[0] || null,
            getRoleById: async id => ({ id_rol: id, code: 'assistant' })
        });
        stub('../../src/services/aws/privateImages', { remove: async () => {}, upload: async () => { throw Error('no upload'); } });
        const migration = require('../migrations/nc1-login-surnames');
        const surnames = require('../../src/util/loginSurnames');
        const dao = require('../../src/Dao/mysql/user.dao');
        const row = async id => (await conn.query('SELECT * FROM login WHERE id_login=?', [id]))[0][0];
        const create = async (id, extra) => { const r = await dao.saveUser({ id_login: 'actor', id_business: 'qa', id_rol: 'r-assistant', email: id + '@example.invalid', phone: '55' + String(Date.now()).slice(-8), password: 'Clave-segura-QA-2026', ...extra }); return r; };
        const createdId = async email => (await conn.query('SELECT id_login FROM login WHERE email=?', [email]))[0][0].id_login;

        // 1. Before the migration: the application keeps working with last_name only.
        let audit = await migration.audit(conn);
        assert.deepEqual(audit, { ready: true, alreadyApplied: false, presentColumns: [] });
        await conn.query('ALTER TABLE login ADD COLUMN first_surname INT NULL');
        await assert.rejects(migration.apply(conn,path.join(backups,'incompatible')), /LOGIN_SURNAMES_INCOMPATIBLE_COLUMNS/);
        assert.equal(fs.existsSync(path.join(backups,'incompatible')),false,'incompatible schema rejected before backup or mutation');
        await conn.query('ALTER TABLE login DROP COLUMN first_surname');
        surnames.resetLoginSurnamesCache();
        await assert.rejects(surnames.writeLoginSurnames({ query: async()=>{throw Error('metadata unavailable');} },'qa',{first_surname:'Prueba'},null), /metadata unavailable/);
        surnames.resetLoginSurnamesCache();
        let created = await create('antes', { first_name: 'Ana', first_surname: 'Pérez', second_surname: 'López' });
        assert.equal(created.status, 200, JSON.stringify(created));
        const before = await row(await createdId('antes@example.invalid'));
        assert.equal(before.last_name, 'Pérez López'); assert.equal(before.name, 'Ana Pérez López'); assert.equal('first_surname' in before, false);

        // 2. Apply: backup of the table definition, additive columns, reentrant.
        audit = await migration.apply(conn, path.join(backups, 'apply'));
        assert.equal(audit.alreadyApplied, true);
        assert.ok(JSON.parse(fs.readFileSync(path.join(backups, 'apply', 'login-surnames-before.json'), 'utf8')).loginTable.includes('CREATE TABLE'));
        assert.equal((await migration.apply(conn, path.join(backups, 'apply-again'))).alreadyApplied, true, 'reentrant');
        assert.equal(fs.existsSync(path.join(backups, 'apply-again')), false, 'no second backup when already applied');
        const legacy = await row('legacy');
        assert.equal(legacy.first_surname, null); assert.equal(legacy.second_surname, null); assert.equal(legacy.last_name, 'Antiguo De La Cuenta', 'existing accounts never split');
        surnames.resetLoginSurnamesCache();

        // 3. After the migration: structured surnames, derived last_name/name, compound names, empty second surname.
        created = await create('despues', { first_name: 'María José', first_surname: 'De la Cruz', second_surname: '' });
        assert.equal(created.status, 200, JSON.stringify(created));
        const id = await createdId('despues@example.invalid');
        let saved = await row(id);
        assert.deepEqual([saved.first_name, saved.first_surname, saved.second_surname, saved.last_name, saved.name], ['María José', 'De la Cruz', null, 'De la Cruz', 'María José De la Cruz']);

        // A different partition is a real change even when joined names and all other columns are identical.
        // Freeze NOW on the single Sequelize connection to reproduce 0 changed rows deterministically.
        await db.query('SET timestamp = 1794898800');
        await db.query("UPDATE login SET updated_at=NOW(),updated_by='actor' WHERE id_login=:id", { replacements: { id } });
        const repartition = await dao.updateUser({ id_login: 'actor', id_business: 'qa', first_surname: 'De la', second_surname: 'Cruz' }, id);
        assert.equal(repartition.status, 200, 'same joined surname must not produce a false 404');
        assert.deepEqual([(await row(id)).first_surname,(await row(id)).second_surname], ['De la','Cruz']);
        await dao.updateUser({ id_login: 'actor', id_business: 'qa', first_surname: 'De la Cruz', second_surname: null }, id);
        await db.query('SET timestamp = 0');

        let updated = await dao.updateUser({ id_login: 'actor', id_business: 'qa', second_surname: 'López Ensayo' }, id);
        assert.equal(updated.status, 200, JSON.stringify(updated));
        assert.equal(updated.data.second_surname, 'López Ensayo'); assert.equal(updated.data.last_name, 'De la Cruz López Ensayo');
        updated = await dao.updateUser({ id_login: 'actor', id_business: 'qa', second_surname: null }, id);
        saved = await row(id);
        assert.deepEqual([saved.second_surname, saved.last_name], [null, 'De la Cruz'], 'explicit clearing, no old value back');
        assert.equal((await dao.updateUser({ id_login: 'actor', id_business: 'qa', first_surname: '', second_surname: '' }, id)).status, 400, 'at least one surname');
        assert.equal((await row(id)).last_name, 'De la Cruz', 'rejected update writes nothing');

        // 4. Older client sends last_name: structured surnames dropped (cannot be split), last_name kept as sent.
        await dao.updateUser({ id_login: 'actor', id_business: 'qa', first_name: 'María José', last_name: 'Otra Forma' }, id);
        saved = await row(id);
        assert.deepEqual([saved.first_surname, saved.second_surname, saved.last_name], [null, null, 'Otra Forma']);

        // 5. Reads carry the surnames.
        const capturedLegacy = await dao.updateUser({ id_login: 'actor', id_business: 'qa', first_surname: 'Antiguo', second_surname: 'De La Cuenta' }, 'legacy');
        assert.equal(capturedLegacy.data.first_surname, 'Antiguo');
        // (Pre-existing: an update with no change at all in the same second answers 404 because MySQL reports 0 affected rows.)
        const listRow = (await dao.updateUser({ id_login: 'actor', id_business: 'qa', email: 'legacy.nuevo@example.invalid' }, 'legacy')).data;
        assert.equal(listRow.second_surname, 'De La Cuenta', 'untouched names keep surnames');

        // 6. Registration provisioning writes the administrator surnames in the same transaction.
        const Provisioning = require('../../src/services/registration/businessProvisioning');
        const provisioning = typeof Provisioning === 'function' ? new Provisioning(db) : new (Provisioning.BusinessProvisioning || Object.values(Provisioning).find(v => typeof v === 'function'))(db);
        await db.transaction(async transaction => provisioning.administrator({ _id_login: 'registered', _id_business: 'qa', _id_rol: 'r-assistant', _name: 'Ana Pérez', _first_name: 'Ana', _last_name: 'Pérez', _first_surname: 'Pérez', _second_surname: null, _email: 'registered@example.invalid', _telephone: '', _password: 'x', _created_by: 'registered' }, transaction));
        saved = await row('registered');
        assert.deepEqual([saved.first_surname, saved.second_surname, saved.last_name], ['Pérez', null, 'Pérez']);

        // 7. Reversal backs up captured values, then drops the columns; re-apply restores the schema.
        const reverted = await migration.revert(conn, path.join(backups, 'revert'));
        assert.deepEqual(reverted.presentColumns, []); assert.equal(reverted.backedUpRows, 2, 'legacy (captured) and registered; the older-client edit cleared the third');
        const values = JSON.parse(fs.readFileSync(path.join(backups, 'revert', 'login-surnames-values.json'), 'utf8'));
        assert.deepEqual(values.map(v => v.id_login).sort(), ['legacy', 'registered']); assert.ok(values.some(v => v.id_login === 'legacy' && v.first_surname === 'Antiguo'));
        surnames.resetLoginSurnamesCache();
        assert.equal((await dao.updateUser({ id_login: 'actor', id_business: 'qa', first_surname: 'Sigue', second_surname: '' }, id)).status, 200, 'works again without the columns');
        assert.equal((await migration.apply(conn, path.join(backups, 'reapply'))).alreadyApplied, true);
    } finally { if (db) await db.close(); await conn.query('DROP DATABASE IF EXISTS ' + database).catch(() => {}); await conn.end(); fs.rmSync(backups, { recursive: true, force: true }); }
});

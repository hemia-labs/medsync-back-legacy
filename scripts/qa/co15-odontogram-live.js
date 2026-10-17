'use strict';

// Real routes/controllers/DAOs/stored procedures on ONE MySQL connection.
// Procedures commit internally, so fixture rows are committed then deleted by
// exact owned ids in finally. Authentication and CSRF are injected at the QA
// boundary; this runner does not validate login, cookies, or production auth.
const assert = require('node:assert/strict');
const express = require('express');
const mysql = require('mysql2/promise');
const { injectReplacements } = require('sequelize/lib/utils/sql');
const config = require('../../src/config/config');
const SecurityConfig = require('../../src/config/security');
const serve = process.argv.includes('--serve');
const business = 'QA_BUSINESS_PROFESSIONAL';
const foreignBusiness = 'QA_BUSINESS_CLINICAL';
const marker = 'QA_CO15_ODONTOGRAM';
const prefix = `qa_co15_${Date.now().toString(36)}_`;
const ids = Object.fromEntries(['patient', 'colleague', 'foreign', 'ui', 'actor', 'denied', 'role', 'deniedRole', 'session', 'deniedSession'].map(key => [key, `${prefix}${key}`]));
const patients = ['patient', 'colleague', 'foreign', 'ui'].map(key => ids[key]);
const dialect = { name: 'mysql', TICK_CHAR_LEFT: '`', TICK_CHAR_RIGHT: '`', canBackslashEscape: () => true, supports: {} };
const injections = [];
let server;
let count = 0;
const checks = [];

function inject(modulePath, exports) {
    const id = require.resolve(modulePath);
    injections.push([id, require.cache[id]]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
}

async function main() {
    assert.notEqual(String(process.env.NODE_ENV).toLowerCase(), 'production', 'QA cannot run in production');
    assert.equal(SecurityConfig.isProductionLike(), false, 'QA cannot run in a production-like runtime');
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    let fixtureStarted = false;
    let queue = Promise.resolve();
    let stop;
    const stopped = new Promise(resolve => { stop = resolve; });
    const shutdown = () => stop();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    const query = async (sql, replacements) => (await connection.query(sql, replacements))[0];

    async function cleanup() {
        if (!fixtureStarted) return;
        await connection.rollback();
        await connection.beginTransaction();
        try {
            const rows = await query('SELECT id_person,created_by FROM person WHERE id_person IN (?)', [patients]);
            assert.ok(rows.every(row => row.created_by === marker), 'Cleanup ownership marker must match');
            await query('DELETE d FROM odontogramDetailv1 d JOIN odontogramv1 o ON o.id_odontogramv1=d.id_odontogramv1 WHERE o.id_person IN (?)', [patients]);
            await query('DELETE FROM odontogramv1 WHERE id_person IN (?)', [patients]);
            await query('DELETE FROM person WHERE id_person IN (?) AND created_by=?', [patients, marker]);
            await query('DELETE FROM business_role_permission WHERE id_rol IN (?)', [[ids.role, ids.deniedRole]]);
            await query('DELETE FROM session WHERE id_session IN (?)', [[ids.session, ids.deniedSession]]);
            await query('DELETE FROM login WHERE id_login IN (?) AND created_by=?', [[ids.actor, ids.denied], marker]);
            await query('DELETE FROM rol WHERE id_rol IN (?)', [[ids.role, ids.deniedRole]]);
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
        for (const [table, column, values] of [
            ['person', 'id_person', patients], ['odontogramv1', 'id_person', patients],
            ['odontogramv1', 'created_by', [ids.actor]], ['odontogramDetailv1', 'created_by', [ids.actor]],
            ['login', 'id_login', [ids.actor, ids.denied]], ['rol', 'id_rol', [ids.role, ids.deniedRole]],
            ['session', 'id_session', [ids.session, ids.deniedSession]],
            ['business_role_permission', 'id_rol', [ids.role, ids.deniedRole]]
        ]) {
            const remaining = await query(`SELECT COUNT(*) n FROM ${table} WHERE ${column} IN (?)`, [values]);
            assert.equal(Number(remaining[0].n), 0, `Owned fixture absent after cleanup: ${table}.${column}`);
        }
        console.log('PASS CO15 cleanup: every owned patient, chart, detail, actor, role and permission is absent; one SQL connection; no existing row changed.');
    }

    try {
        const requiredTables = ['person', 'odontogramv1', 'odontogramDetailv1', 'login', 'rol', 'session', 'business_role_permission'];
        const engines = await query('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)', [requiredTables]);
        assert.equal(engines.length, requiredTables.length);
        assert.ok(engines.every(row => row.ENGINE === 'InnoDB'));
        const procedures = ['SP_OdontogramV1_Save', 'SP_OdontogramDetailv1_Save', 'Sp_OdontogramV1_Change_Status', 'Sp_OdontogramV1_delete', 'SP_OdontogramV1_Get', 'SP_OdontogramV1_Validate', 'Sp_OdontogramV1_History', 'SP_Cat_Type_Tooth_Get'];
        const committing = [];
        for (const name of procedures) {
            const definition = (await query(`SHOW CREATE PROCEDURE ${name}`))[0]['Create Procedure'];
            assert.ok(definition, `Installed procedure ${name}`);
            if (/\b(?:COMMIT|START\s+TRANSACTION)\b/i.test(definition)) committing.push(name);
        }
        assert.ok(committing.length, 'This suite explicitly handles procedures committing fixture rows');
        checks.push(`${committing.length} stored procedures with internal commits: cleanup by exact fixture ids`);
        const businesses = await query('SELECT id_business,active,status,subscription_status FROM business WHERE id_business IN (?)', [[business, foreignBusiness]]);
        assert.equal(businesses.length, 2, 'Existing QA tenants are required');
        assert.ok(businesses.every(row => row.active && row.status === 'active' && row.subscription_status === 'active'));
        if (process.argv.includes('--restore-catalog')) {
            await require('./restore-odontogram-tooth-catalog')(connection, { apply: true });
        }
        const collisions = await query('SELECT COUNT(*) n FROM person WHERE id_person IN (?)', [patients]);
        assert.equal(Number(collisions[0].n), 0, 'New patient ids only');

        inject('../../src/db/Sequelize.connection', {
            async transaction(callback) {
                await connection.beginTransaction();
                const transaction = {
                    finished: false,
                    async commit() { await connection.commit(); this.finished = 'commit'; },
                    async rollback() { await connection.rollback(); this.finished = 'rollback'; }
                };
                if (!callback) return transaction;
                try { const value = await callback(transaction); await transaction.commit(); return value; }
                catch (error) { if (!transaction.finished) await transaction.rollback(); throw error; }
            },
            async query(sql, options = {}) {
                assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE|ALTER|CREATE\s+TABLE)\b/i, 'No schema mutations');
                assert.ok(options.type !== 'SELECT' || /^\s*SELECT\b/i.test(sql), 'Sequelize SELECT formatting cannot receive an INSERT/UPDATE ResultSetHeader');
                const [rows] = await connection.query(injectReplacements(sql, dialect, options.replacements));
                assert.ok(options.type !== 'SELECT' || Array.isArray(rows), 'Sequelize SELECT requires row arrays');
                if (/^\s*CALL\b/i.test(sql)) return rows[0];
                return Array.isArray(rows) ? rows : [rows.affectedRows];
            }
        });
        // Explicit isolated fixture identities, no login credentials or tokens.
        const actors = {
            doctor: { id_login: ids.actor, id_business: business, rol: ids.role, id_session: ids.session },
            denied: { id_login: ids.denied, id_business: business, rol: ids.deniedRole, id_session: ids.deniedSession }
        };
        inject('../../src/auth/authenticate', {
            Auth(req, res, next) {
                const actor = actors[req.get('x-qa-actor') || 'doctor'];
                if (!actor) return res.status(401).json({ status: 401 });
                req.tokenDecode = { ...actor };
                next();
            }
        });
        inject('../../src/middleware/csrf.middleware', { csrfProtection: () => (req, res, next) => next() });

        // Install an empty role and one explicit odontogram grant. Existing roles
        // and user permissions are never modified.
        fixtureStarted = true;
        await connection.beginTransaction();
        await query('INSERT INTO rol (id_rol,code,desc_rol,active) VALUES (?,?,?,1),(?,?,?,1)', [ids.role, ids.role, marker, ids.deniedRole, ids.deniedRole, marker]);
        for (const id of [ids.actor, ids.denied]) {
            await query('INSERT INTO login (id_login,id_business,id_rol,name,active,created_by) VALUES (?,?,?,?,1,?)', [id, business, id === ids.actor ? ids.role : ids.deniedRole, marker, marker]);
            await query('INSERT INTO session (id_session,id_login,`last`,active,created_at,created_by) VALUES (?,?,1,1,NOW(),?)', [id === ids.actor ? ids.session : ids.deniedSession, id, marker]);
        }
        const permissions = await query('SELECT id_cat_permission FROM cat_permission WHERE code=? AND active=1', ['px.tab.odontogram']);
        assert.equal(permissions.length, 1);
        await query('INSERT INTO business_role_permission (id_business,id_rol,id_cat_permission,active,updated_by) VALUES (?,?,?,1,?)', [business, ids.role, permissions[0].id_cat_permission, marker]);
        for (const key of ['patient', 'colleague', 'foreign', 'ui']) {
            await query('INSERT INTO person (id_person,id_business,name,surname,birthday,age,active,created_by) VALUES (?,?,?,?,?,?,1,?)', [ids[key], key === 'foreign' ? foreignBusiness : business, 'QA Odontograma', key === 'ui' ? 'Prueba funcional' : key, '1996-01-01', 30, marker]);
        }
        await connection.commit();

        const app = express();
        app.use(express.json({ limit: '100kb' }));
        app.use((req, res, next) => {
            // Stored procedures use connection-local temporary tables, so all
            // HTTP requests share a sequential queue on the single connection.
            const previous = queue;
            let release;
            queue = new Promise(resolve => { release = resolve; });
            res.once('finish', release);
            res.once('close', release);
            previous.then(() => next(), next);
        });
        app.get('/qa/context', (req, res) => res.json({ patient: { id_person: ids.ui, name: 'QA Odontograma', surname: 'Prueba funcional' }, boundary: 'SQL real; principal QA y CSRF inyectados; limpieza por ids propios' }));
        app.post('/qa/finish', (req, res) => { res.json({ status: 200, cleanup: 'pending' }); stop(); });
        app.use(async (req, res, next) => {
            try {
                // The served QA boundary can only address this run's fixtures,
                // even if a client knows an existing QA tenant's patient id.
                if (!/^\/api\/(?:odontogram\/(?:v1\/|getcatypetooth\/?$)|teeth\/list\/)/.test(req.path)) {
                    return res.status(404).json({ status: 404 });
                }
                const pathPatient = req.path.match(/^\/api\/(?:odontogram\/v1\/(?:odontogram|validate|history)|teeth\/list)\/([^/]+)/);
                const candidates = [req.body && req.body.id_person, pathPatient && decodeURIComponent(pathPatient[1])].filter(Boolean);
                if (candidates.some(id => !patients.includes(id))) return res.status(403).json({ status: 403, message: 'Only current CO15 fixtures are exposed' });
                for (const [field, table, column] of [['id_odontogramv1', 'odontogramv1', 'id_odontogramv1'], ['id_odontogram_detailv1', 'odontogramDetailv1', 'id_odontogram_detailv1']]) {
                    if (req.body && req.body[field]) {
                        const rows = await query(`SELECT created_by FROM ${table} WHERE ${column}=?`, [req.body[field]]);
                        if (!rows[0] || rows[0].created_by !== ids.actor) return res.status(403).json({ status: 403, message: 'Only current CO15 fixture references are exposed' });
                    }
                }
                next();
            } catch (error) { next(error); }
        });
        app.use('/api/odontogram', require('../../src/routes/mysql/odontogram'));
        app.use('/api/teeth', require('../../src/routes/mysql/teeth'));
        app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
            res.status(500).json({ status: 500, message: error.code || 'QA HTTP failure' });
        });
        server = await new Promise((resolve, reject) => {
            const instance = app.listen(serve ? 3019 : 0, '127.0.0.1', () => resolve(instance));
            instance.once('error', reject);
        });
        const base = `http://127.0.0.1:${server.address().port}`;
        async function call(path, method = 'GET', body, actor = 'doctor', expected = 200) {
            const response = await fetch(`${base}/api${path}`, { method, headers: { 'x-qa-actor': actor, 'content-type': 'application/json', connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
            const result = await response.json();
            assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${path}: expected ${expected}, got ${response.status} (${result.message || ''})`);
            count++;
            return result.data;
        }
        const odonto = suffix => `/odontogram/v1/${suffix}`;
        const state = patient => call(odonto(`validate/${patient}`));
        const read = patient => call(odonto(`odontogram/${patient}`));
        const create = (type, extra = {}) => call(odonto('save'), 'POST', { id_person: ids.patient, type, ...extra });
        const status = (chart, active) => call(odonto('status'), 'PUT', { id_odontogramv1: chart.id_odontogramv1, active });
        const before = await state(ids.patient);
        assert.equal(Number(before.active), 0);
        assert.deepEqual(await read(ids.patient), []);
        checks.push('empty patient state');
        const catalog = await call('/odontogram/getcatypetooth');
        assert.ok(Array.isArray(catalog) && catalog.length > 0);
        console.log('CO15 real tooth catalog: ' + JSON.stringify(catalog));
        const charts = [];
        for (const type of catalog) {
            const chart = await create(type.code);
            charts.push(chart);
            const active = await state(ids.patient);
            assert.equal(active.id_odontogramv1, chart.id_odontogramv1);
            assert.equal(active.type, type.code);
            await call(odonto('save'), 'POST', { id_person: ids.patient, type: type.code }, 'doctor', [400, 404, 409]);
            assert.equal(Number((await query('SELECT COUNT(*) n FROM odontogramv1 WHERE id_person=? AND active=1 AND is_active=1', [ids.patient]))[0].n), 1, 'Duplicate active creation leaves exactly one chart');
            await call(odonto('save'), 'POST', { id_person: ids.patient, type: 'NOT_INSTALLED', expand: 'INDICARTOR_DISABLED' }, 'doctor', 400);
            assert.equal((await state(ids.patient)).id_odontogramv1, chart.id_odontogramv1, 'Rejected replacement leaves the original chart active');
            let teeth = await read(ids.patient);
            assert.ok(teeth.length > 0, `Teeth installed for ${type.description}`);
            const expectedTeeth = Number((await query('SELECT COUNT(*) n FROM cat_tooth t JOIN cat_type_tooth c ON c.id_cat_type_tooth=t.id_cat_type_tooth WHERE c.code=?', [type.code]))[0].n);
            assert.equal(teeth.length, expectedTeeth);
            assert.equal(new Set(teeth.map(tooth => tooth.id_tooth)).size, teeth.length);
            const tooth = teeth[0];
            const diagnosis = 'Diagnostico ficticio QA. No usar para atencion.';
            const detail = await call(odonto('detail'), 'POST', { id_person: ids.patient, id_odontogram_detailv1: '', id_tooth: tooth.id_tooth, treatment: diagnosis });
            assert.ok(detail.id_odontogram_detailv1);
            teeth = await read(ids.patient);
            assert.equal(teeth.find(row => row.id_tooth === tooth.id_tooth).treatment, diagnosis);
            const replay = await call(odonto('detail'), 'POST', { id_person: ids.patient, id_odontogram_detailv1: '', id_tooth: tooth.id_tooth, treatment: diagnosis });
            assert.equal(replay.id_odontogram_detailv1, detail.id_odontogram_detailv1, 'Lost-response retry creates no duplicate diagnosis');
            assert.equal(Number((await query('SELECT COUNT(*) n FROM odontogramDetailv1 WHERE id_odontogramv1=? AND id_tooth=?', [chart.id_odontogramv1, tooth.id_tooth]))[0].n), 1);
            const changed = 'Diagnostico ficticio actualizado. CO15 SQL persistence. ' + 'X'.repeat(600);
            await call(odonto('detail'), 'POST', { id_person: ids.patient, id_odontogram_detailv1: detail.id_odontogram_detailv1, id_tooth: tooth.id_tooth, treatment: changed });
            assert.equal((await read(ids.patient)).find(row => row.id_tooth === tooth.id_tooth).treatment, changed);
            await call(odonto('detail'), 'POST', { id_person: ids.patient, id_odontogram_detailv1: detail.id_odontogram_detailv1, id_tooth: tooth.id_tooth, treatment: 'X'.repeat(1001) }, 'doctor', 400);
            const foreignTypeTooth = (await query('SELECT t.id_tooth FROM cat_tooth t JOIN cat_type_tooth c ON c.id_cat_type_tooth=t.id_cat_type_tooth WHERE c.code<>? LIMIT 1', [type.code]))[0];
            if (foreignTypeTooth) await call(odonto('detail'), 'POST', { id_person: ids.patient, id_odontogram_detailv1: '', id_tooth: foreignTypeTooth.id_tooth, treatment: diagnosis }, 'doctor', 400);
            // Another own patient, foreign tenant and mismatched tooth must not
            // be able to reuse a real detail id.
            for (const badPatient of [ids.colleague, ids.foreign]) {
                await call(odonto('detail'), 'POST', { id_person: badPatient, id_odontogram_detailv1: detail.id_odontogram_detailv1, id_tooth: tooth.id_tooth, treatment: diagnosis }, 'doctor', 403);
            }
            await call(odonto('detail'), 'POST', { id_person: ids.patient, id_odontogram_detailv1: detail.id_odontogram_detailv1, id_tooth: teeth[1].id_tooth, treatment: diagnosis }, 'doctor', 403);
            await call(odonto('save'), 'POST', { id_person: ids.patient, type: type.code }, 'denied', 403);
            await call(odonto(`odontogram/${ids.foreign}`), 'GET', undefined, 'doctor', 403);
            await call(odonto('save'), 'POST', { id_person: ids.foreign, type: type.code }, 'doctor', 403);
            await status(chart, false);
            assert.equal(Number((await state(ids.patient)).active), 0);
            assert.deepEqual(await read(ids.patient), []);
            await call(odonto('detail'), 'POST', { id_person: ids.patient, id_odontogram_detailv1: detail.id_odontogram_detailv1, id_tooth: tooth.id_tooth, treatment: diagnosis }, 'doctor', 409);
            await status(chart, true);
            assert.equal((await read(ids.patient)).find(row => row.id_tooth === tooth.id_tooth).treatment, changed, 'Reopening retains diagnosis');
            await call(odonto('detail'), 'POST', { id_person: ids.patient, id_odontogram_detailv1: detail.id_odontogram_detailv1, id_tooth: tooth.id_tooth, treatment: '' }, 'doctor', 400);
            assert.equal((await read(ids.patient)).find(row => row.id_tooth === tooth.id_tooth).treatment, changed, 'Invalid empty diagnosis cannot erase the saved text');
            await status(chart, false);
            checks.push(`${type.description}: ${teeth.length} teeth; create/read/update diagnosis, retry without duplicates, >500 chars retained, finish/reopen persistence and scope denials`);
        }
        const oldChart = charts[0];
        await status(oldChart, true);
        const replacement = await create(catalog[catalog.length - 1].code, { expand: 'INDICARTOR_DISABLED' });
        assert.equal((await state(ids.patient)).id_odontogramv1, replacement.id_odontogramv1);
        const history = await call(odonto(`history/${ids.patient}`));
        assert.equal(history.length, catalog.length + 1);
        assert.equal(history.filter(row => Number(row.active) === 1).length, 1);
        assert.equal(Number(history.find(row => row.id_odontogramv1 === oldChart.id_odontogramv1).active), 0);
        await call(odonto('delete'), 'DELETE', { id_odontogramv1: replacement.id_odontogramv1 });
        assert.equal(Number((await state(ids.patient)).active), 0);
        assert.equal((await call(odonto(`history/${ids.patient}`))).length, catalog.length);
        await call(odonto('status'), 'PUT', { id_odontogramv1: replacement.id_odontogramv1, active: true }, 'doctor', 400);
        assert.equal(Number((await state(ids.patient)).active), 0, 'Deleted chart cannot be reactivated');
        await query('UPDATE person SET active=0 WHERE id_person=? AND created_by=?', [ids.colleague, marker]);
        await call(odonto(`validate/${ids.colleague}`));
        await call(odonto('save'), 'POST', { id_person: ids.colleague, type: catalog[0].code }, 'doctor', 403);
        await call(odonto('status'), 'PUT', { id_odontogramv1: oldChart.id_odontogramv1, active: 'true' }, 'doctor', 400);
        checks.push('replacement/history/soft deletion, archived patient read-only, payload validation');
        console.log(`PASS CO15 real SQL/HTTP: ${count} requests; ${checks.join('; ')}. Authentication/CSRF injected; no browser or login assertion.`);
        if (serve) {
            console.log(`CO15 READY ${base}/qa/context; fresh UI patient=${ids.ui}; POST /qa/finish to stop and verify exact-id cleanup.`);
            await stopped;
        }
    } finally {
        if (server) {
            await new Promise(resolve => server.close(resolve));
            await queue;
        }
        try { await cleanup(); }
        finally {
            await connection.end();
            for (const [id, previous] of injections.reverse()) {
                if (previous) require.cache[id] = previous;
                else delete require.cache[id];
            }
            process.removeListener('SIGINT', shutdown);
            process.removeListener('SIGTERM', shutdown);
        }
    }
}

main().catch(error => {
    console.error('CO15 live:', error.code || error.message, error.code === 'ERR_ASSERTION' ? error.stack : '');
    process.exitCode = 1;
});

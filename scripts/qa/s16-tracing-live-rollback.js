const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');

async function run(connection) {
    let serial = 0, failAudit = false;
    const statements = [];
    const db = {
        async query(sql, options = {}) {
            statements.push(sql);
            if (failAudit && sql.includes('INSERT INTO tracing_revision')) throw new Error('QA forced audit failure');
            const args = [];
            const statement = sql.replace(/:([A-Za-z_]\w*)/g, (_, key) => {
                assert.ok(Object.hasOwn(options.replacements || {}, key), key);
                args.push(options.replacements[key]); return '?';
            });
            const [rows] = await connection.query(statement, args);
            return Array.isArray(rows) ? rows : [rows.affectedRows];
        },
        async transaction() {
            const name = `s16_tracing_${++serial}`;
            await connection.query(`SAVEPOINT ${name}`);
            return {
                finished: false,
                async commit() { await connection.query(`RELEASE SAVEPOINT ${name}`); this.finished = true; },
                async rollback() { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); this.finished = true; }
            };
        }
    };
    const dbPath = require.resolve('../../src/db/Sequelize.connection');
    const oldDb = require.cache[dbPath];
    const modules = ['../../src/util/effectivePermissions', '../../src/util/tracingPermissions', '../../src/Dao/mysql/tracing.Dao'];
    const oldModules = modules.map(name => [require.resolve(name), require.cache[require.resolve(name)]]);
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
    oldModules.forEach(([name]) => { delete require.cache[name]; });
    try {
        await connection.beginTransaction();
        const dao = require('../../src/Dao/mysql/tracing.Dao');
        const { seedTracingPermissions } = require('../../src/util/tracingPermissions');
        const effective = require('../../src/util/effectivePermissions');
        const body = { id_business: 'QA_BUSINESS_CLINICAL', id_login: 'QAC_DOCTOR_1', id_person: 'QAC_PATIENT_01' };
        const [actors] = await connection.query('SELECT id_rol FROM login WHERE id_login = ? AND id_business = ?', [body.id_login, body.id_business]);
        assert.ok(actors.length, 'QA doctor fixture required');
        const role = actors[0].id_rol;
        const grant = async (code, value) => connection.query(`INSERT INTO business_role_permission (id_business, id_rol, id_cat_permission, active)
            SELECT ?, ?, id_cat_permission, ? FROM cat_permission WHERE code = ?
            ON DUPLICATE KEY UPDATE active = VALUES(active)`, [body.id_business, role, value, code]);
        for (const code of ['px.tab.monitoring', 'tracing.create', 'tracing.correct', 'tracing.cancel']) await grant(code, 1);
        const original = { quote_date_now: '13-10-2026', treatment_now: 'QA S16 original', quote_date_after: '00-00-0000', treatment_after: '', note: 'Texto original "sin perder comillas"\nSegunda linea.' };
        const saved = await dao.saveTracing({ ...body, tracing: [original], created_by: 'spoofed-author' });
        assert.equal(saved.status, 200, saved.message);
        const first = saved.data[0];
        assert.equal(first.created_by, body.id_login);
        assert.equal(first.note, original.note);
        assert.equal(Number(first.revision), 1);
        assert.equal(first.quote_date_after, null);
        const next = { ...original, id_tracing: first.id_tracing, revision: 1, note: 'QA corregido', change_reason: 'Aclaracion del registro' };
        assert.equal((await dao.UpdateTracing({ ...body, tracing: [next] })).status, 200);
        assert.equal((await dao.UpdateTracing({ ...body, tracing: [next] })).status, 409, 'Concurrent stale edit rejected');
        let revisions = await dao.revisions({ ...body, id_tracing: first.id_tracing });
        assert.equal(revisions.status, 200);
        assert.equal(revisions.data.length, 2);
        assert.equal(revisions.data[1].snapshot.note, original.note);
        assert.equal(revisions.data[0].snapshot.note, 'QA corregido');
        assert.equal(revisions.data[0].recorded_by, body.id_login);

        failAudit = true;
        assert.equal((await dao.UpdateTracing({ ...body, tracing: [{ ...next, revision: 2, note: 'Must rollback' }] })).status, 500);
        failAudit = false;
        const afterFailure = await dao.record(body, first.id_tracing);
        assert.equal(afterFailure.note, 'QA corregido');
        assert.equal(Number(afterFailure.revision), 2);
        assert.equal((await dao.UpdateTracing({ ...body, tracing: [{ ...next, revision: 2, change_reason: '' }] })).status, 400);
        assert.equal((await dao.DeleteTracing({ ...body, id_tracing: first.id_tracing, revision: 2, change_reason: 'QA anulado' })).status, 200);
        const annulled = await dao.record(body, first.id_tracing);
        assert.equal(annulled.status, 'cancelled');
        assert.equal(annulled.note, 'QA corregido');
        assert.equal(annulled.created_by, body.id_login);
        assert.equal(annulled.cancelled_by, body.id_login);
        assert.equal((await dao.UpdateTracing({ ...body, tracing: [{ ...next, revision: 3 }] })).status, 400);
        const listed = await dao.GetTracing(body);
        assert.equal(listed.status, 200, listed.message);
        assert.ok(listed.data.some(row => row.id_tracing === first.id_tracing && row.status === 'cancelled'));
        assert.equal((await dao.nextQuote(body)).status, 200);
        const [patientState] = await connection.query('SELECT active FROM person WHERE id_person = ?', [body.id_person]);
        await connection.query('UPDATE person SET active = 0 WHERE id_person = ?', [body.id_person]);
        assert.equal((await dao.saveTracing({ ...body, tracing: [original] })).status, 400, 'Archived patients remain readonly');
        assert.equal((await dao.GetTracing(body)).status, 200, 'Archived clinical records stay readable');
        await connection.query('UPDATE person SET active = ? WHERE id_person = ?', [patientState[0].active, body.id_person]);
        assert.equal((await dao.revisions({ ...body, id_person: 'QAP_PATIENT_01', id_tracing: first.id_tracing })).status, 404);
        assert.equal((await dao.GetTracing({ ...body, id_business: 'QA_BUSINESS_PROFESSIONAL' })).status, 403);
        await grant('tracing.correct', 0);
        assert.equal((await dao.UpdateTracing({ ...body, tracing: [{ ...next, revision: 3 }] })).status, 403);
        assert.equal((await dao.saveTracing({ ...body, tracing: [original] })).status, 200, 'Create does not imply correct');
        await seedTracingPermissions(body.id_business, body.id_login);
        assert.equal(await effective.hasPermission(body.id_login, 'tracing.correct'), false, 'Onboarding cannot override explicit denial');
        await grant('px.tab.monitoring', 0);
        const marker = statements.length;
        assert.equal((await dao.GetTracing(body)).status, 403);
        assert.equal((await dao.saveTracing({ ...body, tracing: [original] })).status, 403);
        assert.ok(!statements.slice(marker).some(sql => /(?:FROM|INTO|UPDATE) tracing\b/.test(sql)), 'No clinical read or write after denial');
        await grant('px.tab.monitoring', 1);

        // A pre-migration record receives its real original snapshot before correction.
        const legacyId = uuid();
        await connection.query(`INSERT INTO tracing (id_tracing, id_business, id_person, quote_date_now, treatment_now, treatment_after, note, created_by)
            VALUES (?, ?, ?, '2026-10-13', 'QA legacy', '', 'Legacy preserved', NULL)`, [legacyId, body.id_business, body.id_person]);
        await grant('tracing.correct', 1);
        assert.equal((await dao.UpdateTracing({ ...body, tracing: [{ ...next, id_tracing: legacyId, note: 'Legacy corrected' }] })).status, 200);
        revisions = await dao.revisions({ ...body, id_tracing: legacyId });
        assert.equal(revisions.data.length, 2);
        assert.equal(revisions.data[1].action, 'legacy_baseline');
        assert.equal(revisions.data[1].snapshot.note, 'Legacy preserved');
        assert.equal(revisions.data[1].recorded_by, null, 'Do not invent the legacy author');

        // New staff role: read + draft capture gets create, never correction/cancellation.
        const newRole = `QA-S16-${uuid()}`, newUser = `QA-S16-${uuid()}`;
        await connection.query('INSERT INTO rol (id_rol, code, active) VALUES (?, ?, 1)', [newRole, newRole]);
        await connection.query('INSERT INTO login (id_login, id_business, id_rol, name, active) VALUES (?, ?, ?, ?, 1)', [newUser, body.id_business, newRole, 'QA S16 staff']);
        for (const code of ['px.tab.monitoring', 'clinical_history.edit_draft']) {
            await connection.query(`INSERT INTO business_role_permission (id_business,id_rol,id_cat_permission,active)
                SELECT ?, ?, id_cat_permission, 1 FROM cat_permission WHERE code = ?`, [body.id_business, newRole, code]);
        }
        await seedTracingPermissions(body.id_business, newUser);
        assert.equal(await effective.hasPermission(newUser, 'tracing.create'), true);
        assert.equal(await effective.hasPermission(newUser, 'tracing.correct'), false);
        assert.equal(await effective.hasPermission(newUser, 'tracing.cancel'), false);
        assert.ok(!statements.some(sql => /DELETE\s+FROM\s+tracing\b|SP_tracing_(?:Update|Delete|Save)/i.test(sql)));
        console.log('PASS S16 tracing: live SQL authorization, tenant isolation, author, legacy baseline, correction/cancellation history, concurrency, rollback on audit failure, staff defaults and explicit denial preserved. One connection; all QA writes rolled back.');
    } finally {
        await connection.rollback();
        oldModules.forEach(([name, entry]) => { if (entry) require.cache[name] = entry; else delete require.cache[name]; });
        if (oldDb) require.cache[dbPath] = oldDb; else delete require.cache[dbPath];
    }
}

module.exports = { run };
if (require.main === module) {
    const mysql = require('mysql2/promise');
    const c = require('../../src/config/config');
    (async () => {
        const db = await mysql.createConnection({ host: c.HOSTMYSQL, port: c.PORTMYSQL, user: c.USERMYSQL, password: c.PASSWORDMYSQL, database: c.DATABASEMYSQL });
        try { await run(db); } finally { await db.end(); }
    })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

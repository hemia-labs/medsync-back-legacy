'use strict';
// Uses only fresh random synthetic tenant/patient IDs in the NEW CO26 tables.
// No existing person, login, permission or configuration row is read or changed.
// All SQL writes live inside one outer transaction, rolled back in finally.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const D = require('../../src/domain/odontogram/operations');
(async () => {
    if (!process.argv.includes('--configured')) throw Error('EXPLICIT_CONFIGURED_TARGET_REQUIRED');
    const config = require('../../src/config/config');
    const db = await require('mysql2/promise').createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL,
        password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, namedPlaceholders: true, timezone: 'Z', connectTimeout: 10000 });
    const business = 'co26-qa-' + randomUUID(), patient = randomUUID(), actor = randomUUID();
    const checks = []; let savepoint = 0, mode = 'v2', cleaned = false;
    try {
        await db.beginTransaction();
        const connectionId = require.resolve('../../src/db/Sequelize.connection');
        require.cache[connectionId] = { id: connectionId, filename: connectionId, loaded: true, exports: {
            async query(sql, options) { const [rows] = await db.query(sql, options.replacements); return rows; },
            async transaction() {
                const name = 'co26qa_' + ++savepoint;
                await db.query('SAVEPOINT ' + name);
                return { finished: false,
                    async commit() { await db.query('RELEASE SAVEPOINT ' + name); this.finished = true; },
                    async rollback() { await db.query('ROLLBACK TO SAVEPOINT ' + name); await db.query('RELEASE SAVEPOINT ' + name); this.finished = true; }
                };
            }
        } };
        const dao = require('../../src/Dao/mysql/odontogramV2.dao');
        dao.query = async (sql, values) => { const [rows] = await db.query(sql, values); return rows; };
        // Context and mode are fixtures, deliberately isolated from REAL tenants.
        // Actual authentication/scope/mode middleware has separate regressions.
        dao.context = async (scope, id) => { if (scope !== business || id !== patient) D.fail('Synthetic scope unavailable.', 403); };
        dao.mode = async scope => { if (scope !== business) D.fail('Synthetic scope unavailable.', 403); return mode; };
        const initial = await dao.create(business, actor, patient, { request_id: randomUUID(), mode: 'mixed' });
        assert.equal(Object.keys(initial.teeth).length, 52); checks.push('create_mixed_52');
        const batch = { batch_id: randomUUID(), base_revision: 0, generation: 1, catalog_version: D.CATALOG_VERSION, alias_version: initial.alias_version,
            ops: [{ client_op_id: randomUUID(), type: 'note.set', tooth: 16, text: 'CO26 synthetic QA note' },
                { client_op_id: randomUUID(), type: 'finding.add', tooth: 16, code: 'car', surfaces: 'MO' }] };
        const saved = await dao.operations(business, actor, initial.id_chart, batch);
        assert.equal(saved.revision, 1); assert.equal(saved.teeth[16].note, 'CO26 synthetic QA note'); checks.push('atomic_note_finding_revision');
        assert.deepEqual(await dao.operations(business, actor, initial.id_chart, batch), saved); checks.push('same_batch_receipt');
        await assert.rejects(() => dao.operations(business, actor, initial.id_chart, { ...batch, ops: [{ ...batch.ops[0], text: 'different' }] }), e => e.status === 409);
        await assert.rejects(() => dao.operations(business, actor, initial.id_chart, { ...batch, batch_id: randomUUID() }), e => e.code === 'CO26_MIXED_BATCH'); checks.push('immutable_ids_and_mixed_batch');
        await assert.rejects(() => dao.operations(business, actor, initial.id_chart, { ...batch, batch_id: randomUUID(), ops: [{ client_op_id: randomUUID(), type: 'note.set', tooth: 16, text: 'stale tab' }] }), e => e.code === 'CO26_TOOTH_CONFLICT');
        const merged = await dao.operations(business, actor, initial.id_chart, { ...batch, batch_id: randomUUID(), ops: [{ client_op_id: randomUUID(), type: 'tooth.review', tooth: 55 }] });
        assert.equal(merged.revision, 2); checks.push('same_actor_conflict_and_other_tooth_merge');
        await assert.rejects(() => dao.operations(business, actor, initial.id_chart, { ...batch, batch_id: randomUUID(), base_revision: 2,
            ops: [{ client_op_id: randomUUID(), type: 'note.set', tooth: 17, text: 'Must rollback' }, { client_op_id: randomUUID(), type: 'tooth.review', tooth: 99 }] }), e => e.status === 422);
        assert.equal((await dao.read(business, initial.id_chart)).teeth[17].note, ''); checks.push('invalid_batch_rolls_back');
        const finalized = await dao.lifecycle(business, actor, initial.id_chart, 'finalize', { request_id: randomUUID(), expected_revision: 2, generation: 1 });
        assert.equal(finalized.status, 'finalized');
        assert.deepEqual(await dao.operations(business, actor, initial.id_chart, batch), saved); checks.push('lost_response_retry_after_finalization');
        const temporary = await dao.create(business, actor, patient, { request_id: randomUUID(), mode: 'primary' });
        assert.equal(Object.keys(temporary.teeth).length, 20);
        const copied = await dao.create(business, actor, patient, { request_id: randomUUID(), mode: 'mixed', replace_active_id: temporary.id_chart,
            replace_active_revision: 0, copy_from: initial.id_chart, copy_revision: 2, copy_notes: true });
        assert.equal(copied.teeth[16].note, 'CO26 synthetic QA note');
        assert.notEqual(copied.teeth[16].findings[0].id, saved.teeth[16].findings[0].id);
        assert.equal(copied.teeth[16].reviewed_revision, null); checks.push('primary_creation_and_explicit_snapshot_copy');
        assert.equal((await dao.read(business, initial.id_chart, 0)).teeth[16].note, '');
        assert.equal((await dao.read(business, initial.id_chart, 1)).teeth[16].note, 'CO26 synthetic QA note'); checks.push('exact_snapshot_reads');
        const undoBatch = { batch_id: randomUUID(), base_revision: 0, generation: 1, catalog_version: D.CATALOG_VERSION, alias_version: copied.alias_version,
            ops: [{ client_op_id: randomUUID(), type: 'note.set', tooth: 17, text: 'Undo this' }] };
        const toUndo = await dao.operations(business, actor, copied.id_chart, undoBatch);
        const undone = await dao.operations(business, actor, copied.id_chart, { ...undoBatch, batch_id: randomUUID(), base_revision: toUndo.revision,
            ops: [{ client_op_id: randomUUID(), type: 'operation.undo', tooth: 17, target_op_id: undoBatch.ops[0].client_op_id }] });
        assert.equal(undone.teeth[17].note, ''); checks.push('server_event_undo');
        const [active] = await db.query("SELECT COUNT(*) AS count FROM odontogram_v2_chart WHERE id_business=:business AND status='active'", { business });
        assert.equal(Number(active[0].count), 1); checks.push('one_active_per_patient');
        mode = 'v2_readonly';
        await assert.rejects(() => dao.operations(business, actor, copied.id_chart, { ...undoBatch, batch_id: randomUUID(), base_revision: undone.revision }), e => e.code === 'CO26_MODE'); checks.push('readonly_rejects_new_writes');
        await assert.rejects(() => dao.read('foreign-' + randomUUID(), initial.id_chart), e => e.status === 404); checks.push('tenant_sql_isolation');
        const dental = require('../../src/services/odontogramPlanDental.service');
        const treatment = randomUUID();
        const body = { id_business: business, id_login: actor, id_person: patient, request_id: randomUUID(), name: 'Synthetic procedure', dental_revision: 0, treatment_revision: 0,
            tooth_details: [{ tooth_number: '16', surfaces: 'MO', sources: [{ id_chart: initial.id_chart, revision: 1, finding_id: saved.teeth[16].findings[0].id, context: { label: 'Untrusted label' } }] },
                { tooth_number: '55', surfaces: null, manual: true, sources: [] }] };
        let state = await dental.formState(body, treatment, {}, false);
        let prepared = await dental.prepare(body, treatment, [], {}, true);
        await dental.persist(body, treatment, prepared, {}); await dental.recordForm(body, treatment, state, null, { name: body.name }, {}, false);
        let loaded = await dental.load(business, treatment, [], {});
        assert.equal(loaded.revision, 1); assert.equal(loaded.form_revision, 1); assert.equal(loaded.details[0].surfaces, 'MO');
        assert.equal(loaded.details[0].sources[0].context.label, 'Caries'); checks.push('plan_rich_faces_verified_origin');
        await dental.assertCreateRetry(body, treatment, {});
        await assert.rejects(() => dental.assertCreateRetry({ ...body, name: 'Changed request content' }, treatment, {}), e => e.code === 'CO26_TREATMENT_REQUEST'); checks.push('plan_create_request_hash');
        const added = D.clone(loaded.details);
        added.find(detail => detail.tooth_number === '55').sources = [{ id_chart: initial.id_chart, revision: 1, finding_id: null }, { id_chart: initial.id_chart, revision: 1, finding_id: null }];
        const updated = { ...body, dental_revision: 1, treatment_revision: 1, tooth_details: added };
        state = await dental.formState(updated, treatment, {}, true);
        prepared = await dental.prepare(updated, treatment, ['16','55'], {}, true);
        await dental.persist(updated, treatment, prepared, {}); await dental.recordForm(updated, treatment, state, {}, {}, {}, true);
        loaded = await dental.load(business, treatment, ['16','55'], {});
        assert.equal(loaded.details.find(detail => detail.tooth_number === '55').sources.length, 1); checks.push('plan_null_finding_source_dedup');
        await db.query("UPDATE odontogram_v2_chart SET status='deleted' WHERE id_business=:business AND id_chart=:chart", { business, chart: initial.id_chart });
        const restricted = { ...body, dental_revision: loaded.revision, treatment_revision: loaded.form_revision, tooth_details: loaded.details.map(detail => ({ tooth_number: detail.tooth_number, surfaces: detail.tooth_number === '16' ? 'D' : detail.surfaces, sources_redacted: true })) };
        state = await dental.formState(restricted, treatment, {}, true);
        prepared = await dental.prepare(restricted, treatment, ['16','55'], {}, false);
        await dental.persist(restricted, treatment, prepared, {}); await dental.recordForm(restricted, treatment, state, {}, {}, {}, true);
        loaded = await dental.load(business, treatment, ['16','55'], {});
        assert.equal(loaded.details[0].surfaces, 'MOD'); assert.equal(loaded.details[0].manual_surfaces,'D'); assert.equal(loaded.details[0].sources.length, 1);
        await assert.rejects(() => dental.formState(updated, treatment, {}, true), e => e.code === 'CO26_TREATMENT_REVISION');
        await assert.rejects(() => dental.prepare(body, randomUUID(), [], {}, true), e => e.status === 403); checks.push('plan_source_unavailable_preserved_and_stale_form_rejected');
        const safe = await dental.attach({ id_business: business }, [{ id_patient_treatment: treatment, teeth: ['16','55'] }], {}, false);
        assert.equal(safe[0].tooth_details[0].sources, undefined); assert.equal(safe[0].tooth_details[0].sources_redacted, true); checks.push('plan_origin_redaction');
        const aliasRepo=require('../../src/services/odontogramAliases.service');
        const oldAliases=await aliasRepo.state(business);
        await db.query(`INSERT INTO odontogram_alias(scope_key,scope_kind,id_business,alias,target,version,active,updated_by,updated_at)
            VALUES(:scope,'tenant',:business,'qabrief','res',1,1,:actor,NOW(3))`,{scope:'tenant:'+business,business,actor});
        const nextAliases=await aliasRepo.state(business);assert.notEqual(nextAliases.alias_version,oldAliases.alias_version);assert.equal(nextAliases.aliases.qabrief,'res');
        assert.equal((await aliasRepo.state('foreign-'+randomUUID())).aliases.qabrief,undefined);
        mode='v2';
        await assert.rejects(()=>dao.operations(business,actor,copied.id_chart,{...undoBatch,batch_id:randomUUID(),base_revision:undone.revision,ops:[{client_op_id:randomUUID(),type:'finding.add',tooth:18,code:'res',surfaces:'O'}]}),e=>e.code==='CO26_ALIASES');
        const confirmed=await dao.operations(business,actor,copied.id_chart,undoBatch);assert.equal(confirmed.revision,toUndo.revision);
        checks.push('alias_version_scope_and_confirmed_retry');
        const copyBody={request_id:randomUUID(),mode:'primary',replace_active_id:copied.id_chart,replace_active_revision:undone.revision,copy_from:copied.id_chart,copy_revision:undone.revision,copy_findings:[],copy_notes:true};
        await assert.rejects(()=>dao.create(business,actor,patient,copyBody),e=>e.status===422);
        assert.equal((await dao.read(business,copied.id_chart)).status,'active');
        const primaryCopy=await dao.create(business,actor,patient,{...copyBody,incompatible_decision:'omit'});
        assert.equal(Object.keys(primaryCopy.teeth).length,20);assert.equal(primaryCopy.copied_from.omitted_teeth.length,32);checks.push('copy_incompatible_explicit_decision_and_swap_rollback');
        const deletion={request_id:randomUUID(),expected_revision:0,generation:1};
        const deleted=await dao.lifecycle(business,actor,primaryCopy.id_chart,'delete',deletion);assert.equal(deleted.status,'deleted');assert.equal(deleted.teeth,undefined);
        assert.deepEqual(await dao.lifecycle(business,actor,primaryCopy.id_chart,'delete',deletion),deleted);
        await assert.rejects(()=>dao.read(business,primaryCopy.id_chart),e=>e.status===404);
        await assert.rejects(()=>dao.create(business,actor,patient,{...copyBody,incompatible_decision:'omit'}),e=>e.status===404);checks.push('deleted_parent_visibility_and_minimal_idempotent_ack');
    } finally {
        try {
            await db.rollback();
            const [rows] = await db.query('SELECT COUNT(*) AS count FROM odontogram_v2_chart WHERE id_business=:business', { business });
            const [planRows] = await db.query('SELECT COUNT(*) AS count FROM odontogram_plan_dental_revision WHERE id_business=:business', { business });
            const [aliasRows] = await db.query('SELECT COUNT(*) AS count FROM odontogram_alias WHERE id_business=:business',{business});
            cleaned = Number(rows[0].count) === 0 && Number(planRows[0].count) === 0 && Number(aliasRows[0].count)===0;
        } finally { await db.end(); }
    }
    assert.equal(cleaned, true, 'Synthetic records must be absent after rollback');
    const fs = require('node:fs/promises'), path = require('node:path');
    const target = path.resolve(__dirname, '../../../roadmap/evidence/CO26/configured-mysql-results.json');
    await fs.writeFile(target, JSON.stringify({ pass: true, checked_at: new Date().toISOString(), checks, synthetic_rows_rolled_back: true,
        real_patient_or_permission_rows_changed: false, scope_and_mode_fixtures: true, authenticated_http_test: false }, null, 2));
    console.log('PASS configured MySQL: ' + checks.length + ' synthetic DAO/SQL scenarios; all fixture rows rolled back. No real patient/configuration/permission rows changed. Scope/mode were fixtures, not an authenticated HTTP test.');
})().catch(error => { console.error('CO26 configured MySQL QA failed:', error.code || 'ASSERTION_OR_TEST_FAILURE'); process.exitCode = 1; });

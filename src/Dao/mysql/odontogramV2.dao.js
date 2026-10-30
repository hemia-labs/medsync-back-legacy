'use strict';
const { QueryTypes } = require('sequelize');
const { randomUUID } = require('node:crypto');
const sequelize = require('../../db/Sequelize.connection');
const D = require('../../domain/odontogram/operations');
const aliases = require('../../services/odontogramAliases.service');
const preferences = require('../../services/odontogramPreferences.service');
const eq = (left, right) => `${left} COLLATE utf8mb4_unicode_ci = ${right} COLLATE utf8mb4_unicode_ci`;
class OdontogramV2Dao {
    query(sql, values, transaction) { return sequelize.query(sql, { replacements: values, type: /^\s*SELECT/.test(sql) ? QueryTypes.SELECT : QueryTypes.RAW, transaction, logging: false }); }
    async mode(business, transaction, lock = false) {
        const rows = await this.query(`SELECT odontogram_mode FROM clinical_module_config WHERE ${eq('id_business', ':business')} ${lock ? 'FOR UPDATE' : ''}`, { business }, transaction);
        return rows[0] && rows[0].odontogram_mode || 'v1';
    }
    async activationMatrix(business,transaction=null) {
        const joins=require('../../util/effectivePermissions').joins();
        const rows=await this.query(`SELECT l.id_login,l.id_rol,r.code AS role_code,cp.code FROM login l
            JOIN rol r ON ${eq('r.id_rol','l.id_rol')} AND r.active=1 ${joins}
            WHERE ${eq('l.id_business',':business')} AND l.active=1 AND cp.is_active=1 AND COALESCE(bp.active,pr.active,0)=1
            AND cp.code IN ('px.tab.odontogram','odontogram.capture','odontogram.finalize','odontogram.reopen','odontogram.delete','clinical_history.finalize','clinical_history.cancel')
            ORDER BY l.id_rol,l.id_login,cp.code ${transaction?'FOR UPDATE':''}`,{business},transaction);
        const users=new Map(),roles=new Map();
        for(const row of rows){if(!users.has(row.id_login))users.set(row.id_login,new Set());users.get(row.id_login).add(row.code);if(!roles.has(row.id_rol))roles.set(row.id_rol,{id_rol:row.id_rol,role_code:row.role_code,permissions:new Set()});roles.get(row.id_rol).permissions.add(row.code);}
        const capture=[...users.values()].filter(codes=>codes.has('px.tab.odontogram')&&codes.has('odontogram.capture')).length;
        const finalize=[...users.values()].filter(codes=>codes.has('px.tab.odontogram')&&codes.has('odontogram.finalize')).length;
        return {ready:capture>0&&finalize>0,capture_operators:capture,finalize_operators:finalize,roles:[...roles.values()].map(role=>{
            const read=role.permissions.has('px.tab.odontogram');
            return {id_rol:role.id_rol,role_code:role.role_code,read,capture:role.permissions.has('odontogram.capture'),finalize:role.permissions.has('odontogram.finalize'),reopen:role.permissions.has('odontogram.reopen'),delete:role.permissions.has('odontogram.delete'),
                candidates:{capture:read,finalize:read&&role.permissions.has('clinical_history.finalize'),reopen:read&&role.permissions.has('clinical_history.finalize'),delete:read&&role.permissions.has('clinical_history.cancel')}};
        })};
    }
    async context(business, patient, transaction, write) {
        D.validId(patient);
        const rows = await this.query(`SELECT id_person FROM person WHERE ${eq('id_person', ':patient')} AND ${eq('id_business', ':business')} ${write ? 'AND active=1 FOR UPDATE' : ''}`, { business, patient }, transaction);
        if (!rows.length) D.fail('Paciente no disponible en este consultorio.', 403);
    }
    async baseline(business, actor, transaction) {
        // Caller locks every owning patient, then the tenant configuration.
        // No text is classified as a finding/review, and no history is invented.
        const rows = await this.query(`SELECT o.* FROM odontogramv1 o JOIN person p ON ${eq('p.id_person', 'o.id_person')}
            WHERE ${eq('p.id_business', ':business')} AND o.is_active=1
            AND NOT EXISTS(SELECT 1 FROM odontogram_v2_chart v WHERE v.id_business=:business AND ${eq('v.id_chart', 'o.id_odontogramv1')})
            ORDER BY o.id_person,o.id_odontogramv1 FOR UPDATE`, { business }, transaction);
        const activePatients = new Set();
        for (const row of rows) {
            if (row.id_business !== business) D.fail('El negocio del odontograma legacy es inconsistente.', 409);
            if (Number(row.active) && activePatients.has(row.id_person)) D.fail('Hay varios odontogramas activos; resuelve el preflight antes de habilitar CO26.', 409);
            if (Number(row.active)) activePatients.add(row.id_person);
            const catalog = await this.query(`SELECT ct.id_tooth,ct.sec FROM cat_tooth ct JOIN cat_type_tooth t
                ON ${eq('t.id_cat_type_tooth', 'ct.id_cat_type_tooth')} WHERE ${eq('t.code', ':type')}`, { type: row.type }, transaction);
            const unique = new Set(catalog.map(tooth => Number(tooth.sec))).size === catalog.length;
            const primary = unique && catalog.length === 20 && catalog.every(tooth => /^[5-8][1-5]$/.test(String(tooth.sec)));
            const permanent = unique && catalog.length === 32 && catalog.every(tooth => /^[1-4][1-8]$/.test(String(tooth.sec)));
            if (!primary && !permanent) D.fail('El catálogo legacy no corresponde a 20 o 32 piezas válidas.', 409);
            const snapshot = D.emptyChart(primary ? 'primary' : 'permanent');
            snapshot.status = Number(row.active) ? 'active' : 'finalized';
            snapshot.created_by = row.created_by;
            snapshot.baseline = { legacy_id: row.id_odontogramv1, original_created_at: row.created_at, captured_by: actor, captured_at: new Date().toISOString(), history_before_baseline: false };
            const notes = await this.query(`SELECT ct.sec,d.treatment FROM odontogramDetailv1 d JOIN cat_tooth ct ON ${eq('ct.id_tooth', 'd.id_tooth')}
                WHERE ${eq('d.id_odontogramv1', ':id')} AND d.active=1 AND d.is_active=1`, { id: row.id_odontogramv1 }, transaction);
            for (const note of notes) {
                const tooth = snapshot.teeth[note.sec];
                if (!tooth || typeof note.treatment !== 'string' || note.treatment.length > 1000 || tooth.note && tooth.note !== note.treatment) D.fail('Notas legacy incompatibles o duplicadas; revisa el preflight.', 409);
                tooth.note = note.treatment;
            }
            await this.project(business, row.id_odontogramv1, actor, snapshot, transaction, true, row.id_person);
        }
        return rows.length;
    }
    async chart(business, id, transaction, lock = false) {
        D.validId(id);
        const rows = await this.query(`SELECT * FROM odontogram_v2_chart WHERE id_business=:business AND id_chart=:id ${lock ? 'FOR UPDATE' : ''}`, { business, id }, transaction);
        if (!rows.length) D.fail('Odontograma no disponible.', 404);
        return rows[0];
    }
    async list(business, patient) {
        await this.context(business, patient, null, false);
        const mode = await this.mode(business);
        const charts = await this.query(`SELECT id_chart,id_person,dentition,revision,generation,status,created_by,created_at,updated_by,updated_at
            FROM odontogram_v2_chart WHERE id_business=:business AND id_person=:patient AND status<>'deleted' ORDER BY created_at DESC,id_chart`, { business, patient });
        return { mode, catalog_version: D.CATALOG_VERSION, catalog: D.CATALOG, ...await aliases.state(business), capture_preferences:await preferences.state(business), metrics_enabled:require('../../services/odontogramMetrics.service').enabled(), charts };
    }
    async read(business, id, revision) {
        const row = await this.chart(business, id);
        await this.context(business, row.id_person, null, false);
        if (row.status === 'deleted') D.fail('Odontograma no disponible.', 404);
        let snapshot = JSON.parse(row.snapshot_json);
        if (revision !== undefined) {
            if (!/^\d+$/.test(String(revision)) || !Number.isSafeInteger(Number(revision))) D.fail('Revisión inválida.');
            const versions = await this.query('SELECT snapshot_json FROM odontogram_v2_revision WHERE id_business=:business AND id_chart=:id AND revision=:revision', { business, id, revision: Number(revision) });
            if (!versions.length) D.fail('Revisión no disponible.', 404);
            snapshot = JSON.parse(versions[0].snapshot_json);
        }
        const aliasState = await aliases.state(business);
        return { id_chart: id, id_person: row.id_person, ...snapshot, edit_catalog_version: D.CATALOG_VERSION, alias_version: aliasState.alias_version, aliases: aliasState.aliases, capture_preferences:await preferences.state(business) };
    }
    async receipt(business, batch, actor, id, payload, transaction, allowDeleted = false) {
        const rows = await this.query('SELECT * FROM odontogram_v2_batch WHERE id_business=:business AND batch_id=:batch', { business, batch }, transaction);
        if (!rows.length) return null;
        const row = rows[0];
        if (row.actor !== actor || id && row.id_chart !== id || row.request_hash !== D.hash(payload)) D.fail('Identidad idempotente reutilizada con otro contenido.', 409, 'CO26_BATCH_REUSED');
        const parents=await this.query('SELECT status FROM odontogram_v2_chart WHERE id_business=:business AND id_chart=:id',{business,id:row.id_chart},transaction);
        if(!parents.length||parents[0].status==='deleted'&&!allowDeleted)D.fail('Odontograma no disponible.',404);
        return JSON.parse(row.result_json);
    }
    async saveReceipt(business, batch, actor, id, payload, result, transaction) {
        await this.query(`INSERT INTO odontogram_v2_batch(id_business,batch_id,id_chart,actor,request_hash,result_json,created_at)
            VALUES(:business,:batch,:id,:actor,:hash,:result,NOW(3))`, { business, batch, id, actor, hash: D.hash(payload), result: JSON.stringify(result) }, transaction);
    }
    async project(business, id, actor, snapshot, transaction, create = false, patient = null) {
        const data = { business, id, actor, snapshot: JSON.stringify(snapshot), revision: snapshot.revision,
            generation: snapshot.generation, status: snapshot.status, mode: snapshot.mode, patient,
            createdAt: snapshot.baseline && snapshot.baseline.original_created_at || new Date(), createdBy: snapshot.created_by || actor };
        if (create) await this.query(`INSERT INTO odontogram_v2_chart(id_business,id_chart,id_person,dentition,revision,generation,status,snapshot_json,created_by,created_at,updated_by,updated_at)
            VALUES(:business,:id,:patient,:mode,:revision,:generation,:status,:snapshot,:createdBy,:createdAt,:actor,NOW(3))`, data, transaction);
        else await this.query(`UPDATE odontogram_v2_chart SET revision=:revision,generation=:generation,status=:status,snapshot_json=:snapshot,updated_by=:actor,updated_at=NOW(3)
            WHERE id_business=:business AND id_chart=:id`, data, transaction);
        await this.query(`INSERT INTO odontogram_v2_revision(id_business,id_chart,revision,snapshot_json,actor,created_at)
            VALUES(:business,:id,:revision,:snapshot,:actor,NOW(3))`, data, transaction);
        if (!create) await this.query("UPDATE odontogram_v2_finding SET status='historical' WHERE id_business=:business AND id_chart=:id", { business, id }, transaction);
        for (const [tooth, state] of Object.entries(snapshot.teeth)) {
            await this.query(`INSERT INTO odontogram_v2_tooth(id_business,id_chart,tooth,revision,review_revision,note)
                VALUES(:business,:id,:tooth,:revision,:review,:note) ON DUPLICATE KEY UPDATE revision=VALUES(revision),review_revision=VALUES(review_revision),note=VALUES(note)`,
            { business, id, tooth, revision: state.version, review: state.reviewed_revision, note: state.note }, transaction);
            for (const finding of state.findings) await this.query(`INSERT INTO odontogram_v2_finding(id_business,id_chart,finding_id,tooth,status,finding_json)
                VALUES(:business,:id,:finding,:tooth,:status,:json) ON DUPLICATE KEY UPDATE status=VALUES(status),finding_json=VALUES(finding_json)`,
            { business, id, finding: finding.id, tooth, status: finding.status, json: JSON.stringify(finding) }, transaction);
        }
    }
    async mutate(business, actor, patient, work) {
        const transaction = await sequelize.transaction();
        try {
            await this.context(business, patient, transaction, true);
            const mode = await this.mode(business, transaction, true);
            // Recognize confirmed retries before checking active/mode in work.
            const result = await work(transaction, mode);
            await transaction.commit(); return result;
        } catch (error) { if (!transaction.finished) await transaction.rollback(); throw error; }
    }
    assertWritable(mode) {
        if (mode !== 'v2') D.fail(mode === 'v2_readonly' ? 'Odontograma en solo lectura.' : 'CO26 no está habilitado en este consultorio.', 409, 'CO26_MODE');
    }
    async operations(business, actor, id, batch) {
        D.validateBatch(batch);
        const reference = await this.chart(business, id);
        return this.mutate(business, actor, reference.id_person, async (transaction, mode) => {
            const previous = await this.receipt(business, batch.batch_id, actor, id, batch, transaction);
            if (previous) return previous;
            this.assertWritable(mode);
            const aliasState = await aliases.state(business, transaction);
            if (aliasState.conflicts.length || batch.alias_version !== aliasState.alias_version) D.fail('Las abreviaturas cambiaron o el cliente está desactualizado. Recarga la captura y revisa el comando.', 409, 'CO26_ALIASES');
            const row = await this.chart(business, id, transaction, true);
            for (const op of batch.ops) {
                const used = await this.query('SELECT client_op_id FROM odontogram_v2_operation WHERE id_business=:business AND client_op_id=:op', { business, op: op.client_op_id }, transaction);
                if (used.length) D.fail('No se puede reagrupar un lote confirmado.', 409, 'CO26_MIXED_BATCH');
            }
            const undoEvents = {};
            for (const op of batch.ops.filter(op => op.type === 'operation.undo')) {
                D.validId(op.target_op_id);
                const previousEvents = await this.query('SELECT event_json,revision,actor FROM odontogram_v2_operation WHERE id_business=:business AND id_chart=:id AND client_op_id=:op', { business, id, op: op.target_op_id }, transaction);
                if (!previousEvents.length) D.fail('Operación original no disponible.', 409);
                undoEvents[op.target_op_id] = { ...previousEvents[0], event: JSON.parse(previousEvents[0].event_json) };
            }
            const result = D.applyBatch(JSON.parse(row.snapshot_json), batch, actor, undoEvents);
            if (result.changed) await this.project(business, id, actor, result.chart, transaction);
            const response = { id_chart: id, ...result.chart, edit_catalog_version: D.CATALOG_VERSION, alias_version: aliasState.alias_version, aliases: aliasState.aliases, confirmed_revision: result.chart.revision };
            await this.saveReceipt(business, batch.batch_id, actor, id, batch, response, transaction);
            for (const op of batch.ops) await this.query(`INSERT INTO odontogram_v2_operation(id_business,client_op_id,id_chart,batch_id,revision,actor,event_json,created_at)
                VALUES(:business,:op,:id,:batch,:revision,:actor,:event,NOW(3))`,
            { business, op: op.client_op_id, id, batch: batch.batch_id, revision: result.chart.revision, actor,
                event: JSON.stringify(result.events.find(e => e.client_op_id === op.client_op_id) || { type: op.type, tooth: op.tooth, noop: true }) }, transaction);
            return response;
        });
    }
    async create(business, actor, patient, body) {
        D.validId(body.request_id);
        if (body.copy_from && (!Number.isSafeInteger(body.copy_revision) || body.copy_revision < 0)) D.fail('Revisión de origen inválida.');
        if (Buffer.byteLength(JSON.stringify(body)) > 131072) D.fail('Solicitud demasiado grande.');
        let initial;
        try { initial = D.emptyChart(body.mode); } catch (error) { D.fail(error.message); }
        return this.mutate(business, actor, patient, async (transaction, mode) => {
            const previous = await this.receipt(business, body.request_id, actor, null, { ...body, patient }, transaction);
            if (previous) return previous;
            this.assertWritable(mode);
            const charts = await this.query(`SELECT * FROM odontogram_v2_chart WHERE id_business=:business AND id_person=:patient
                AND status='active' ORDER BY id_chart FOR UPDATE`, { business, patient }, transaction);
            if (charts.length) {
                const active = charts[0];
                if (active.id_chart !== body.replace_active_id || active.revision !== body.replace_active_revision) D.fail('Revisa el odontograma activo antes de sustituirlo.', 409);
                const closed = JSON.parse(active.snapshot_json);
                closed.status = 'finalized'; closed.revision++; closed.generation++; closed.finalized_by = actor;
                await this.project(business, active.id_chart, actor, closed, transaction);
            } else if (body.replace_active_id) D.fail('El activo cambió.', 409);
            if (body.copy_from) {
                const source = await this.chart(business, body.copy_from, transaction, true);
                if (source.id_person !== patient || source.status === 'deleted') D.fail('Origen de copia no disponible.', 403);
                const versions = await this.query('SELECT snapshot_json FROM odontogram_v2_revision WHERE id_business=:business AND id_chart=:id AND revision=:revision', { business, id: body.copy_from, revision: body.copy_revision }, transaction);
                if (!versions.length) D.fail('Revisión de origen no disponible.', 409);
                const snapshot = JSON.parse(versions[0].snapshot_json);
                const incompatible=Object.keys(snapshot.teeth).filter(n=>!initial.teeth[n]);
                if(incompatible.length&&body.incompatible_decision!=='omit')D.fail('Confirma qué hacer con las piezas incompatibles antes de copiar.');
                const available=Object.values(snapshot.teeth).flatMap(tooth=>tooth.findings.filter(f=>f.status==='active').map(f=>f.id));
                if(body.copy_findings!==undefined&&(!Array.isArray(body.copy_findings)||body.copy_findings.some(id=>!available.includes(id))))D.fail('La selección de copia no pertenece a la revisión elegida.',403);
                const selected=body.copy_findings===undefined?new Set(available):new Set(body.copy_findings);
                if(incompatible.some(n=>snapshot.teeth[n].findings.some(f=>selected.has(f.id))))D.fail('Retira de la selección los hallazgos de piezas incompatibles.');
                for (const [n, tooth] of Object.entries(snapshot.teeth)) {
                    if(!initial.teeth[n])continue;
                    initial.teeth[n].findings = tooth.findings.filter(f => f.status === 'active'&&selected.has(f.id)).map(f => ({ ...f, id: randomUUID(), actor, created_revision: 0, copied_from: { id_chart: body.copy_from, revision: body.copy_revision, finding_id: f.id }, requires_reevaluation: true }));
                    if (body.copy_notes === true) initial.teeth[n].note = tooth.note;
                }
                initial.copied_from = { id_chart: body.copy_from, revision: body.copy_revision, notes: body.copy_notes === true, omitted_teeth: incompatible };
            }
            const id = randomUUID();
            initial.created_by = actor;
            await this.project(business, id, actor, initial, transaction, true, patient);
            const aliasState = await aliases.state(business, transaction);
            const response = { id_chart: id, id_person: patient, ...initial, edit_catalog_version: D.CATALOG_VERSION, alias_version: aliasState.alias_version, aliases: aliasState.aliases };
            await this.saveReceipt(business, body.request_id, actor, id, { ...body, patient }, response, transaction);
            return response;
        });
    }
    async lifecycle(business, actor, id, action, body) {
        D.validId(body.request_id);
        if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0 || !Number.isSafeInteger(body.generation)) D.fail('Revisión o generación inválida.');
        if (!['finalize', 'reopen', 'delete'].includes(action)) D.fail('Acción inválida.');
        const reference = await this.chart(business, id);
        return this.mutate(business, actor, reference.id_person, async (transaction, mode) => {
            const payload = { ...body, action };
            const previous = await this.receipt(business, body.request_id, actor, id, payload, transaction, action==='delete');
            if (previous) return previous;
            this.assertWritable(mode);
            const rows = await this.query('SELECT * FROM odontogram_v2_chart WHERE id_business=:business AND id_person=:patient ORDER BY id_chart FOR UPDATE', { business, patient: reference.id_person }, transaction);
            const row = rows.find(item => item.id_chart === id);
            if (!row || row.revision !== body.expected_revision || row.generation !== body.generation || row.status === 'deleted') D.fail('El odontograma cambió; recarga.', 409);
            const snapshot = JSON.parse(row.snapshot_json);
            if (action === 'finalize' && snapshot.status !== 'active' || action === 'reopen' && snapshot.status !== 'finalized') D.fail('Transición no permitida.', 409);
            if (action === 'reopen') {
                const active = rows.find(item => item.status === 'active');
                if (active) {
                    if (active.id_chart !== body.replace_active_id || active.revision !== body.replace_active_revision) D.fail('Revisa el activo antes de reabrir.', 409);
                    const closed = JSON.parse(active.snapshot_json); closed.status = 'finalized'; closed.revision++; closed.generation++; closed.finalized_by = actor;
                    await this.project(business, active.id_chart, actor, closed, transaction);
                } else if (body.replace_active_id) D.fail('El activo cambió.', 409);
            }
            snapshot.status = { finalize: 'finalized', reopen: 'active', delete: 'deleted' }[action];
            snapshot.revision++; snapshot.generation++;
            snapshot.last_transition = { action, actor };
            if (action === 'finalize') snapshot.finalized_by = actor;
            await this.project(business, id, actor, snapshot, transaction);
            const response = action==='delete' ? {id_chart:id,status:'deleted',revision:snapshot.revision,generation:snapshot.generation,confirmed_revision:snapshot.revision} : { id_chart: id, ...snapshot };
            await this.saveReceipt(business, body.request_id, actor, id, payload, response, transaction);
            return response;
        });
    }
}
module.exports = new OdontogramV2Dao();

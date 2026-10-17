const { QueryTypes } = require('sequelize');
const { v4: uuid } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const { hasPermission } = require('../../util/effectivePermissions');
const validation = require('../../domain/tracing/tracingValidation');

const eq = (a, b) => `${a} COLLATE utf8mb4_unicode_ci = ${b} COLLATE utf8mb4_unicode_ci`;
const conflict = () => ({ status: 409, data: { code: 'TRACING_REVISION_CONFLICT' }, message: 'Este seguimiento cambio mientras lo editabas. Tu captura sigue abierta; consulta la version actual antes de corregirlo.' });
const createConflict = () => ({ status: 409, data: { code: 'TRACING_CREATE_CONFLICT' }, message: 'Esta captura ya se guardo con otro contenido. Consulta el seguimiento guardado antes de corregirlo; no se creo otro registro.' });

class TracingDao {
    async context(body, permission, transaction = null, patient = true) {
        if (!body.id_login || !body.id_business || body.rol === 'super_admin') return { error: responseData.forbidden('No tienes acceso al seguimiento.') };
        const actors = await sequelize.query(`SELECT l.id_login FROM login l INNER JOIN rol r ON ${eq('r.id_rol', 'l.id_rol')}
            WHERE ${eq('l.id_login', ':actor')} AND ${eq('l.id_business', ':business')}
              AND l.active = 1 AND r.active = 1 AND r.code <> 'super_admin' LIMIT 1`, {
            replacements: { actor: body.id_login, business: body.id_business }, type: QueryTypes.SELECT, transaction
        });
        if (!actors.length || !await hasPermission(body.id_login, 'px.tab.monitoring', { transaction })
            || (permission !== 'px.tab.monitoring' && !await hasPermission(body.id_login, permission, { transaction }))) {
            return { error: responseData.forbidden('No tienes permiso para esta accion de seguimiento.') };
        }
        if (patient) {
            if (!body.id_person) return { error: responseData.bad_request('Indica el paciente.') };
            const people = await sequelize.query(`SELECT id_person, active FROM person WHERE ${eq('id_person', ':patient')} AND ${eq('id_business', ':business')} LIMIT 1`, {
                replacements: { patient: body.id_person, business: body.id_business }, type: QueryTypes.SELECT, transaction
            });
            if (!people.length) return { error: responseData.notSuccess('Paciente no encontrado.') };
            if (permission !== 'px.tab.monitoring' && String(people[0].active) === '0') {
                return { error: responseData.bad_request('El paciente esta archivado. Reactivalo antes de modificar su seguimiento.') };
            }
        }
        return {};
    }

    async record(body, id, transaction = null, lock = false) {
        const result = await sequelize.query(`SELECT t.* FROM tracing t WHERE ${eq('t.id_tracing', ':id')}
            AND ${eq('t.id_person', ':patient')} AND ${eq('t.id_business', ':business')} ${lock ? 'FOR UPDATE' : ''}`, {
            replacements: { id, patient: body.id_person, business: body.id_business }, type: QueryTypes.SELECT, transaction
        });
        return result[0] || null;
    }

    async appendVersion(row, body, action, reason, transaction) {
        // Store a complete immutable snapshot; never reconstruct old content from current rows.
        await sequelize.query(`INSERT INTO tracing_revision
            (id_tracing_revision, id_tracing, id_business, id_person, revision, action, snapshot_json, change_reason, recorded_at, recorded_by)
            VALUES (:id, :tracing, :business, :patient, :revision, :action, :snapshot, :reason, NOW(), :actor)`, {
            replacements: { id: uuid(), tracing: row.id_tracing, business: body.id_business, patient: body.id_person,
                revision: row.revision, action, snapshot: JSON.stringify(row), reason: reason || null,
                actor: action === 'legacy_baseline' ? null : body.id_login }, transaction
        });
    }

    async preserveBaseline(row, body, transaction) {
        const existing = await sequelize.query(`SELECT id_tracing_revision FROM tracing_revision
            WHERE ${eq('id_tracing', ':id')} AND ${eq('id_business', ':business')} AND revision = :revision LIMIT 1`, {
            replacements: { id: row.id_tracing, business: body.id_business, revision: row.revision }, type: QueryTypes.SELECT, transaction
        });
        if (!existing.length) await this.appendVersion(row, body, 'legacy_baseline', null, transaction);
    }

    async lockPatient(body, transaction) {
        // Shares the patient lock used by plan mutations, so a selected plan cannot close mid-save.
        await sequelize.query(`SELECT id_person FROM person WHERE ${eq('id_person', ':patient')}
            AND ${eq('id_business', ':business')} FOR UPDATE`, {
            replacements: { patient: body.id_person, business: body.id_business }, type: QueryTypes.SELECT, transaction
        });
    }

    async treatmentRelation(body, row, previous, transaction) {
        const provided = Object.prototype.hasOwnProperty.call(row, 'id_patient_treatment');
        const id = provided ? row.id_patient_treatment : previous && previous.id_patient_treatment;
        if (!id) return { ...row, id_patient_treatment: null, id_treatment_plan: null, treatment_relation_type: null, treatment_text: null };
        if (previous && id === previous.id_patient_treatment) {
            // Closing or renaming a plan never rewrites a previously recorded procedure.
            return { ...row, treatment_now: previous.treatment_now, id_patient_treatment: id,
                id_treatment_plan: previous.id_treatment_plan, treatment_relation_type: previous.treatment_relation_type || 'performed',
                treatment_text: previous.treatment_text || previous.treatment_now };
        }
        const items = await sequelize.query(`SELECT pt.id_patient_treatment, pt.id_treatment_plan, pt.name
            FROM patient_treatment pt INNER JOIN treatment_plan tp
              ON ${eq('tp.id_treatment_plan', 'pt.id_treatment_plan')} AND ${eq('tp.id_business', 'pt.id_business')}
              AND ${eq('tp.id_person', 'pt.id_person')}
            WHERE ${eq('pt.id_patient_treatment', ':treatment')} AND ${eq('pt.id_person', ':patient')}
              AND ${eq('pt.id_business', ':business')} AND pt.active = 1 AND tp.active = 1 AND tp.status = 'active'
              AND pt.status <> 'cancelled' LIMIT 1 FOR UPDATE`, {
            replacements: { treatment: id, patient: body.id_person, business: body.id_business }, type: QueryTypes.SELECT, transaction
        });
        if (!items.length) return { error: responseData.bad_request('El tratamiento ya no esta disponible en el plan activo de este paciente. Selecciona otro o captura el procedimiento como texto libre.') };
        return { ...row, id_patient_treatment: id, id_treatment_plan: items[0].id_treatment_plan,
            treatment_now: items[0].name, treatment_relation_type: 'performed', treatment_text: items[0].name };
    }

    sameCreation(current, candidate, body) {
        if (current.created_by !== body.id_login || current.status !== 'active' || Number(current.revision) !== 1) return false;
        const dateText = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
        return ['quote_date_now', 'quote_date_after'].every(key => dateText(current[key]) === dateText(candidate[key]))
            && ['treatment_now', 'treatment_after', 'note', 'id_patient_treatment'].every(key => String(current[key] || '') === String(candidate[key] || ''));
    }

    async saveTracing(body) {
        let rows;
        try { rows = validation.rows(body); } catch (error) { return responseData.bad_request(error.message); }
        return this.mutate(body, 'tracing.create', async transaction => {
            await this.lockPatient(body, transaction);
            const saved = [];
            for (const row of rows) {
                const id = row.id_tracing || uuid();
                const existing = row.id_tracing ? await this.record(body, id, transaction, true) : null;
                const linked = await this.treatmentRelation(body, row, existing, transaction);
                if (linked.error) return linked.error;
                if (existing) {
                    if (!this.sameCreation(existing, linked, body)) return createConflict();
                    saved.push(existing);
                    continue;
                }
                await sequelize.query(`INSERT INTO tracing (id_tracing, id_business, id_person, quote_date_now, treatment_now,
                    quote_date_after, treatment_after, note, id_treatment_plan, id_patient_treatment, treatment_relation_type, treatment_text,
                    created_at, created_by, revision, status)
                    VALUES (:id, :business, :patient, :quote_date_now, :treatment_now, :quote_date_after, :treatment_after, :note,
                    :id_treatment_plan, :id_patient_treatment, :treatment_relation_type, :treatment_text, NOW(), :actor, 1, 'active')`, {
                    replacements: { ...linked, id, business: body.id_business, patient: body.id_person, actor: body.id_login }, transaction
                });
                const current = await this.record(body, id, transaction);
                await this.appendVersion(current, body, 'created', null, transaction);
                saved.push(current);
            }
            return responseData.success(saved, 'Seguimiento guardado.');
        });
    }

    async UpdateTracing(body) {
        let rows;
        try { rows = validation.rows(body, true); } catch (error) { return responseData.bad_request(error.message); }
        return this.mutate(body, 'tracing.correct', async transaction => {
            await this.lockPatient(body, transaction);
            const saved = [];
            for (const row of rows) {
                const previous = await this.record(body, row.id_tracing, transaction, true);
                if (!previous) return responseData.notSuccess('Seguimiento no encontrado.');
                if (previous.status !== 'active') return responseData.bad_request('Un seguimiento anulado se conserva solo para consulta.');
                if (Number(previous.revision) !== row.revision) return conflict();
                if (previous.id_patient_treatment && row.id_patient_treatment !== null
                    && (!row.id_patient_treatment || row.id_patient_treatment === previous.id_patient_treatment)
                    && row.treatment_now !== previous.treatment_now) {
                    return responseData.bad_request('El nombre del procedimiento vinculado conserva lo registrado. Para corregir ese texto, elige captura libre; la version anterior seguira disponible.');
                }
                const linked = await this.treatmentRelation(body, row, previous, transaction);
                if (linked.error) return linked.error;
                await this.preserveBaseline(previous, body, transaction);
                await sequelize.query(`UPDATE tracing SET quote_date_now = :quote_date_now, treatment_now = :treatment_now,
                    quote_date_after = :quote_date_after, treatment_after = :treatment_after, note = :note,
                    id_treatment_plan = :id_treatment_plan, id_patient_treatment = :id_patient_treatment,
                    treatment_relation_type = :treatment_relation_type, treatment_text = :treatment_text,
                    updated_at = NOW(), updated_by = :actor, revision = revision + 1
                    WHERE ${eq('id_tracing', ':id')} AND ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')}`, {
                    replacements: { ...linked, id: row.id_tracing, actor: body.id_login, business: body.id_business, patient: body.id_person }, transaction
                });
                const current = await this.record(body, row.id_tracing, transaction);
                await this.appendVersion(current, body, 'corrected', row.change_reason, transaction);
                saved.push(current);
            }
            return responseData.success(saved, 'Correccion guardada; la version anterior se conserva.');
        });
    }

    async DeleteTracing(body) {
        // Legacy endpoint name is retained for clients. This operation only annuls.
        let revision, reason;
        try {
            revision = validation.revision(body.revision);
            reason = validation.text(body.change_reason, 1000, true);
            validation.text(body.id_tracing, 50, true);
        } catch (error) { return responseData.bad_request(error.message); }
        return this.mutate(body, 'tracing.cancel', async transaction => {
            const previous = await this.record(body, body.id_tracing, transaction, true);
            if (!previous) return responseData.notSuccess('Seguimiento no encontrado.');
            if (Number(previous.revision) !== revision) return conflict();
            if (previous.status !== 'active') return responseData.bad_request('El seguimiento ya esta anulado.');
            await this.preserveBaseline(previous, body, transaction);
            await sequelize.query(`UPDATE tracing SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = :actor,
                cancellation_reason = :reason, updated_at = NOW(), updated_by = :actor, revision = revision + 1
                WHERE ${eq('id_tracing', ':id')} AND ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')}`, {
                replacements: { id: body.id_tracing, actor: body.id_login, reason, business: body.id_business, patient: body.id_person }, transaction
            });
            const current = await this.record(body, body.id_tracing, transaction);
            await this.appendVersion(current, body, 'cancelled', reason, transaction);
            return responseData.success(current, 'Seguimiento anulado. El contenido y sus cambios se conservan; las citas de agenda no se cancelaron.');
        });
    }

    async mutate(body, permission, change) {
        let transaction;
        try {
            transaction = await sequelize.transaction();
            const context = await this.context(body, permission, transaction);
            if (context.error) { await transaction.rollback(); return context.error; }
            const result = await change(transaction);
            if (result.status !== 200) { await transaction.rollback(); return result; }
            await transaction.commit();
            return result;
        } catch (error) {
            if (transaction && !transaction.finished) await transaction.rollback();
            return responseData.error('No se pudo confirmar el guardado del seguimiento. Conserva tu captura y consulta el registro antes de reintentar.');
        }
    }

    async GetTracing(body) {
        try {
            const context = await this.context(body, 'px.tab.monitoring');
            if (context.error) return context.error;
            const result = await sequelize.query(`SELECT t.*, DATE_FORMAT(t.quote_date_now, '%d-%m-%Y') AS quote_date_now,
                DATE_FORMAT(t.quote_date_after, '%d-%m-%Y') AS quote_date_after,
                l.name AS author_name
                FROM tracing t LEFT JOIN login l ON ${eq('l.id_login', 't.created_by')} AND ${eq('l.id_business', 't.id_business')}
                WHERE ${eq('t.id_person', ':patient')} AND ${eq('t.id_business', ':business')}
                ORDER BY t.quote_date_now DESC, t.created_at DESC`, {
                replacements: { patient: body.id_person, business: body.id_business }, type: QueryTypes.SELECT
            });
            return responseData.success(result, 'Seguimientos consultados.');
        } catch (error) { return responseData.error('No se pudieron consultar los seguimientos.'); }
    }

    async revisions(body) {
        try {
            const context = await this.context(body, 'px.tab.monitoring');
            if (context.error) return context.error;
            const current = await this.record(body, body.id_tracing);
            if (!current) return responseData.notSuccess('Seguimiento no encontrado.');
            const result = await sequelize.query(`SELECT r.*, l.name AS actor_name
                FROM tracing_revision r LEFT JOIN login l ON ${eq('l.id_login', 'r.recorded_by')} AND ${eq('l.id_business', 'r.id_business')}
                WHERE ${eq('r.id_tracing', ':id')} AND ${eq('r.id_business', ':business')} AND ${eq('r.id_person', ':patient')}
                ORDER BY r.revision DESC`, {
                replacements: { id: body.id_tracing, business: body.id_business, patient: body.id_person }, type: QueryTypes.SELECT
            });
            return responseData.success(result.map(row => ({ ...row, snapshot: typeof row.snapshot_json === 'string' ? JSON.parse(row.snapshot_json) : row.snapshot_json, snapshot_json: undefined })), 'Cambios del seguimiento.');
        } catch (error) { return responseData.error('No se pudieron consultar los cambios.'); }
    }

    async nextQuote(body) {
        try {
            const context = await this.context(body, 'px.tab.monitoring', null, false);
            if (context.error) return context.error;
            const result = await sequelize.query(`SELECT t.id_tracing, t.treatment_now, t.quote_date_after, t.treatment_after,
                p.id_person, CONCAT_WS(' ', p.name, p.surname) AS name, p.code, p.telephone
                FROM tracing t INNER JOIN person p ON ${eq('p.id_person', 't.id_person')} AND ${eq('p.id_business', 't.id_business')}
                WHERE ${eq('t.id_business', ':business')} AND t.status = 'active'
                  AND t.quote_date_after >= CURRENT_DATE()
                  AND t.quote_date_after <= DATE_ADD((SELECT MIN(t2.quote_date_after) FROM tracing t2
                      WHERE ${eq('t2.id_business', ':business')} AND t2.status = 'active' AND t2.quote_date_after >= CURRENT_DATE()), INTERVAL 20 DAY)
                ORDER BY t.quote_date_after`, {
                replacements: { business: body.id_business }, type: QueryTypes.SELECT
            });
            return responseData.success(result, 'Proximos seguimientos.');
        } catch (error) { return responseData.error('No se pudieron consultar los proximos seguimientos.'); }
    }
}

module.exports = new TracingDao();

const { QueryTypes } = require('sequelize');
const { v4: uuid } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const response = require('../../util/responsedata');
const { hydrateAllergy, validateReview, applyCurrentAllergy, STATUS } = require('../../domain/clinicalHistory/allergyStatus');
const eq = (column, value) => `${column} COLLATE utf8mb4_unicode_ci = ${value} COLLATE utf8mb4_unicode_ci`;

class PatientAllergyDao {
    async lockPatient(patientId, businessId, transaction) {
        const rows = await sequelize.query(`SELECT id_person FROM person WHERE ${eq('id_person', ':patient')} AND ${eq('id_business', ':business')} AND active = 1 FOR UPDATE`,
            { replacements: { patient: patientId, business: businessId }, type: QueryTypes.SELECT, transaction });
        return !!rows[0];
    }
    async getCurrent(patientId, businessId, transaction = null) {
        const rows = await sequelize.query(`SELECT a.* FROM allergy a INNER JOIN person p ON ${eq('p.id_person', 'a.id_patient')}
            WHERE ${eq('p.id_person', ':patient')} AND ${eq('p.id_business', ':business')}
            AND (${eq('a.id_business', ':business')} OR a.id_business IS NULL) AND a.active = 1 AND a.is_active = 1
            ORDER BY a.revision DESC, a.updated_at DESC, a.created_at DESC, a.id_allergy LIMIT 1 ${transaction ? 'FOR UPDATE' : ''}`,
            { replacements: { patient: patientId, business: businessId }, type: QueryTypes.SELECT, transaction });
        return hydrateAllergy(rows[0] || {});
    }
    async synchronizeDrafts(patientId, businessId, current, userId, transaction) {
        const rows = await sequelize.query(`SELECT id_clinical_history, clinical_snapshot_json FROM clinical_histories
            WHERE ${eq('patient_id', ':patient')} AND ${eq('business_id', ':business')} AND status = 'DRAFT' AND deleted_at IS NULL FOR UPDATE`,
            { replacements: { patient: patientId, business: businessId }, type: QueryTypes.SELECT, transaction });
        for (const row of rows) {
            const source = typeof row.clinical_snapshot_json === 'string' ? JSON.parse(row.clinical_snapshot_json) : row.clinical_snapshot_json;
            await sequelize.query(`UPDATE clinical_histories SET clinical_snapshot_json = :snapshot, revision = revision + 1, updated_at = NOW(), updated_by_user_id = :user
                WHERE ${eq('id_clinical_history', ':history')} AND ${eq('business_id', ':business')} AND status = 'DRAFT'`,
                { replacements: { snapshot: JSON.stringify(applyCurrentAllergy(source, current)), user: userId, history: row.id_clinical_history, business: businessId }, transaction });
            await sequelize.query(`INSERT INTO clinical_history_events (id_clinical_history_event, clinical_history_id, business_id, patient_id, event_type, user_id, metadata_json, created_at)
                VALUES (:id, :history, :business, :patient, 'ALLERGIES_REVIEWED', :user, :metadata, NOW())`,
                { replacements: { id: uuid(), history: row.id_clinical_history, business: businessId, patient: patientId, user: userId, metadata: JSON.stringify({ revision: current.revision }) }, transaction });
        }
    }
    async update(body) {
        if (typeof body.patient_id !== 'string' || !body.patient_id.trim() || body.patient_id.length > 36) return response.bad_request('Indica un paciente valido.');
        const error = validateReview(body);
        if (error) return response.bad_request(error);
        const transaction = await sequelize.transaction();
        try {
            if (!await this.lockPatient(body.patient_id, body.id_business, transaction)) { await transaction.rollback(); return response.forbidden('Paciente no disponible en este consultorio.'); }
            const previous = await this.getCurrent(body.patient_id, body.id_business, transaction);
            if (previous.revision !== body.expected_revision) { await transaction.rollback(); return { status: 409, data: null, message: 'Las alergias cambiaron en otra sesion. Revisa el estado actual antes de reemplazarlo.' }; }
            const id = previous.id_allergy || uuid();
            const description = body.review_status === STATUS.NONE_KNOWN ? '' : body.description.trim();
            const values = { id, business: body.id_business, patient: body.patient_id, status: body.review_status,
                has: body.review_status === STATUS.HAS_ALLERGIES ? 1 : body.review_status === STATUS.NONE_KNOWN ? 0 : null,
                description, user: body.id_login, revision: previous.revision + 1 };
            if (previous.id_allergy) {
                await sequelize.query(`UPDATE allergy SET id_business = :business, has_allergy = :has, description = :description,
                    review_status = :status, revision = :revision, reviewed_at = NOW(3), reviewed_by = :user, updated_at = NOW(), updated_by = :user
                    WHERE ${eq('id_allergy', ':id')} AND ${eq('id_patient', ':patient')}`, { replacements: values, transaction });
            } else {
                await sequelize.query(`INSERT INTO allergy (id_allergy, id_business, id_patient, has_allergy, description, review_status, revision, reviewed_at, reviewed_by, created_by)
                    VALUES (:id, :business, :patient, :has, :description, :status, :revision, NOW(3), :user, :user)`, { replacements: values, transaction });
            }
            const current = await this.getCurrent(body.patient_id, body.id_business, transaction);
            await sequelize.query(`INSERT INTO patient_allergy_events (id_event, business_id, patient_id, user_id, revision, snapshot_json, created_at)
                VALUES (:id, :business, :patient, :user, :revision, :snapshot, NOW(3))`,
                { replacements: { ...values, id: uuid(), snapshot: JSON.stringify(current) }, transaction });
            await this.synchronizeDrafts(body.patient_id, body.id_business, current, body.id_login, transaction);
            await transaction.commit();
            return response.success(current, 'Alergias actualizadas.');
        } catch (error) { await transaction.rollback(); throw error; }
    }
}
module.exports = new PatientAllergyDao();

const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const permissions = require('../../util/effectivePermissions');
const responseData = require('../../util/responsedata');
const { SequelizeException } = require('../../util/sequelizeException');
const History = require('./clinicalHistory.dao');
const Allergies = require('./patientAllergy.dao');
const { applyCurrentAllergy } = require('../../domain/clinicalHistory/allergyStatus');
const { revisionConflict } = require('../../domain/clinicalHistory/historyIntegrity');
const { validateConsultation, mergeConsultation, projectIntake, intakeFields } = require('../../domain/clinicalHistory/intake');
const LicenseUsage = require('./licenseUsage.dao');
const { getSaasPlan } = require('../../config/saasPlans');

const eq = (left, right) => `${left} COLLATE utf8mb4_unicode_ci = ${right} COLLATE utf8mb4_unicode_ci`;

class ClinicalIntakeDao {
    async allowed(body) {
        return await permissions.hasPermission(body.id_login, 'clinical_history.intake', { enabledCatalog: true })
            && await permissions.hasPermission(body.id_login, 'px.all', { enabledCatalog: true });
    }
    async latest(body, transaction = null) {
        const rows = await sequelize.query(`SELECT ch.id_clinical_history, ch.status, ch.revision, ch.clinical_snapshot_json,
            ch.template_snapshot_json, ch.updated_at, ch.doctor_responsible_profile_id, ch.doctor_responsible_user_id,
            d.professional_name AS responsible_doctor_name
            FROM clinical_histories ch LEFT JOIN doctor_professional_profile d ON ${eq('d.id_business', 'ch.business_id')}
              AND (${eq('d.id_doctor_professional_profile', 'ch.doctor_responsible_profile_id')}
                OR (ch.doctor_responsible_profile_id IS NULL AND ${eq('d.id_login', 'ch.doctor_responsible_user_id')}))
            WHERE ${eq('ch.business_id', ':business')} AND ${eq('ch.patient_id', ':patient')}
            AND ch.status <> 'CANCELLED' AND ch.deleted_at IS NULL ORDER BY ch.version_number DESC, ch.created_at DESC LIMIT 1`, {
            replacements: { business: body.id_business, patient: body.patient_id }, type: QueryTypes.SELECT, transaction
        });
        return rows[0] || null;
    }
    async recipientDoctors(body, transaction = null) {
        // Intake receives only ID/name. Login is used internally for the existing
        // responsible columns; signatures, credentials and licenses are not read.
        return sequelize.query(`SELECT d.id_doctor_professional_profile, d.id_login, d.professional_name
            FROM doctor_professional_profile d JOIN login l ON ${eq('l.id_login', 'd.id_login')}
              AND ${eq('l.id_business', 'd.id_business')} AND l.active = 1
            WHERE ${eq('d.id_business', ':business')} AND d.is_active = 1
            ORDER BY d.professional_name, d.id_doctor_professional_profile`, {
            replacements: { business: body.id_business }, type: QueryTypes.SELECT, transaction
        });
    }
    async project(body, history, patient, template = null, transaction = null) {
        const result = projectIntake(history, patient, template);
        if (!result.editable) return result;
        const doctors = await this.recipientDoctors(body, transaction);
        const locked = Boolean(history && (history.doctor_responsible_profile_id || history.doctor_responsible_user_id));
        const current = locked ? doctors.find(doctor => history.doctor_responsible_profile_id
            ? doctor.id_doctor_professional_profile === history.doctor_responsible_profile_id
            : doctor.id_login === history.doctor_responsible_user_id) : null;
        let suggested = null;
        if (!locked && doctors.length === 1) {
            const business = await LicenseUsage.getBusinessPlan(body.id_business);
            const plan = business && getSaasPlan(business.plan);
            if (plan && ['basic', 'pro'].includes(plan.code)) suggested = doctors[0].id_doctor_professional_profile;
        }
        return { ...result,
            doctors: doctors.map(doctor => ({ id_doctor_professional_profile: doctor.id_doctor_professional_profile, professional_name: doctor.professional_name })),
            suggested_doctor_profile_id: suggested,
            responsible_doctor: locked ? { id_doctor_professional_profile: current ? current.id_doctor_professional_profile : history.doctor_responsible_profile_id,
                professional_name: current ? current.professional_name : history.responsible_doctor_name || 'Doctor asignado no disponible' } : null,
            doctor_assignment_locked: locked, assigned_doctor_available: !locked || Boolean(current)
        };
    }
    async resolveRecipient(body, history, transaction) {
        const requested = body.doctor_responsible_profile_id;
        if (requested != null && (typeof requested !== 'string' || requested.length > 50)) return { error: responseData.bad_request('Doctor destinatario invalido.') };
        const doctors = await this.recipientDoctors(body, transaction);
        const assigned = Boolean(history && (history.doctor_responsible_profile_id || history.doctor_responsible_user_id));
        const doctor = assigned ? doctors.find(item => history.doctor_responsible_profile_id
            ? item.id_doctor_professional_profile === history.doctor_responsible_profile_id
            : item.id_login === history.doctor_responsible_user_id)
            : doctors.find(item => item.id_doctor_professional_profile === requested);
        const assignedProfile = assigned && (history.doctor_responsible_profile_id || doctor && doctor.id_doctor_professional_profile);
        if (assigned && requested && assignedProfile && requested !== assignedProfile) {
            return { error: responseData.forbidden('El borrador ya tiene doctor asignado. Su cambio requiere el editor clinico autorizado.') };
        }
        if (!doctor) return { error: responseData.bad_request(assigned
            ? 'El doctor asignado ya no esta disponible. Solicita su cambio desde el editor clinico antes de continuar.'
            : 'Selecciona un doctor activo de este consultorio para revisar el borrador.') };
        return { doctor, newlyAssigned: !assigned };
    }
    async get(body) {
        try {
            if (!await this.allowed(body)) return responseData.forbidden('No tienes permiso para la captura inicial.');
            const patient = await History.getPatient(body.patient_id, body.id_business);
            if (!patient) return responseData.forbidden('Paciente no disponible para esta operacion.');
            const history = await this.latest(body);
            if (history && history.status === 'DRAFT') await History.addEvent(history.id_clinical_history, body.id_business, body.patient_id, body.id_login, 'VIEWED', { context: 'reception_intake', fields: ['consultation'] });
            const template = history ? null : await History.resolveTemplateSnapshot(body.id_business);
            return responseData.success(await this.project(body, history, patient, template && template.templateSnapshotJson), 'Captura inicial consultada.');
        } catch (error) { return SequelizeException(error, 'No fue posible consultar la captura inicial.'); }
    }
    async save(body) {
        if (!await this.allowed(body)) return responseData.forbidden('No tienes permiso para la captura inicial.');
        const invalid = validateConsultation(body.consultation);
        if (invalid) return responseData.bad_request(invalid);
        // Never interpret a full-history payload as an intake patch.
        const permitted = ['id_business', 'id_login', 'rol', 'patient_id', 'id_clinical_history', 'expected_revision', 'consultation', 'doctor_responsible_profile_id'];
        if (Object.keys(body).some(key => !permitted.includes(key))) return responseData.bad_request('La captura inicial solo permite motivo y relato del paciente.');
        const transaction = await sequelize.transaction();
        try {
            if (!await Allergies.lockPatient(body.patient_id, body.id_business, transaction)) {
                await transaction.rollback(); return responseData.forbidden('Paciente no disponible para esta operacion.');
            }
            const patient = await History.getPatient(body.patient_id, body.id_business, transaction);
            if (!patient) { await transaction.rollback(); return responseData.forbidden('Paciente no disponible para esta operacion.'); }
            let history = await this.latest(body, transaction);
            if (history && (history.status !== 'DRAFT' || history.id_clinical_history !== body.id_clinical_history)) {
                await transaction.rollback();
                return { status: 409, data: { code: 'HISTORY_REVISION_CONFLICT' }, message: 'La historia cambio. Tu captura se conserva; carga la version actual antes de continuar.' };
            }
            if (!history && body.id_clinical_history) {
                await transaction.rollback(); return { status: 409, data: { code: 'HISTORY_REVISION_CONFLICT' }, message: 'El borrador ya no esta disponible. Tu captura se conserva.' };
            }
            const template = history ? { templateSnapshotJson: history.template_snapshot_json } : await History.resolveTemplateSnapshot(body.id_business, transaction);
            const allowedFields = intakeFields(template.templateSnapshotJson);
            if (!allowedFields.length || Object.keys(body.consultation).some(field => !allowedFields.includes(field))) {
                await transaction.rollback(); return responseData.bad_request('El formato no permite estos campos en la captura inicial. Carga la version actual.');
            }
            if (history) {
                const conflict = revisionConflict(history, body.expected_revision);
                if (conflict) { await transaction.rollback(); return conflict; }
            }
            const recipient = await this.resolveRecipient(body, history, transaction);
            if (recipient.error) { await transaction.rollback(); return recipient.error; }
            const doctor = recipient.doctor;
            if (history) {
                const snapshot = mergeConsultation(history.clinical_snapshot_json, body.consultation);
                await sequelize.query(`UPDATE clinical_histories SET clinical_snapshot_json = :snapshot, revision = revision + 1,
                    doctor_responsible_profile_id = :doctorProfile, doctor_responsible_user_id = :doctorLogin,
                    updated_by_user_id = :actor, updated_at = NOW() WHERE ${eq('id_clinical_history', ':history')} AND ${eq('business_id', ':business')} AND status = 'DRAFT'`, {
                    replacements: { snapshot: JSON.stringify(snapshot), doctorProfile: doctor.id_doctor_professional_profile, doctorLogin: doctor.id_login,
                        actor: body.id_login, history: history.id_clinical_history, business: body.id_business }, transaction
                });
                await History.addEvent(history.id_clinical_history, body.id_business, body.patient_id, body.id_login, 'UPDATED', {
                    context: 'reception_intake', fields: Object.keys(body.consultation).map(key => `consultation.${key}`),
                    ...(recipient.newlyAssigned ? { doctor_assignment: { doctor_profile_id: doctor.id_doctor_professional_profile, doctor_user_id: doctor.id_login } } : {})
                }, transaction);
            } else {
                if (!Object.values(body.consultation).some(value => value.trim())) { await transaction.rollback(); return responseData.bad_request('Escribe el motivo o relato del paciente antes de crear el borrador.'); }
                const id = uuidv4();
                const snapshot = applyCurrentAllergy(mergeConsultation({ identification: { full_name: patient.full_name, age: patient.age, birth_date: patient.birthday } }, body.consultation), await Allergies.getCurrent(body.patient_id, body.id_business, transaction));
                await sequelize.query(`INSERT INTO clinical_histories (id_clinical_history, business_id, patient_id, created_by_user_id,
                    doctor_responsible_profile_id, doctor_responsible_user_id,
                    status, version_number, source, template_version_id, template_snapshot_json, clinical_snapshot_json, created_at, updated_at)
                    VALUES (:history, :business, :patient, :actor, :doctorProfile, :doctorLogin, 'DRAFT', :version, 'MANUAL', :template, :schema, :snapshot, NOW(), NOW())`, {
                    replacements: { history: id, business: body.id_business, patient: body.patient_id, actor: body.id_login,
                        doctorProfile: doctor.id_doctor_professional_profile, doctorLogin: doctor.id_login,
                        version: await History.nextVersion(body.patient_id, body.id_business, transaction), template: template.templateVersionId,
                        schema: template.templateSnapshotJson, snapshot: JSON.stringify(snapshot) }, transaction
                });
                await History.addEvent(id, body.id_business, body.patient_id, body.id_login, 'CREATED', { context: 'reception_intake', source: 'MANUAL',
                    doctor_assignment: { doctor_profile_id: doctor.id_doctor_professional_profile, doctor_user_id: doctor.id_login } }, transaction);
            }
            history = await this.latest(body, transaction);
            const projected = await this.project(body, history, patient, null, transaction);
            await transaction.commit();
            return responseData.success(projected, 'Captura inicial guardada como borrador. Pendiente de revision del doctor.');
        } catch (error) {
            await transaction.rollback(); return SequelizeException(error, 'No fue posible guardar la captura inicial.');
        }
    }
}
module.exports = new ClinicalIntakeDao();

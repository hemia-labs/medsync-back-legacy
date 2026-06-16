const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const ClinicalHistoryTemplateDao = require('./clinicalHistoryTemplate.dao');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const collateEq = (left, param) => `${left} COLLATE ${TENANT_COLLATION} = ${param} COLLATE ${TENANT_COLLATION}`;

const STATUS = {
    DRAFT: 'DRAFT',
    FINALIZED: 'FINALIZED',
    INCOMPLETE: 'INCOMPLETE',
    SUPERSEDED: 'SUPERSEDED',
    CANCELLED: 'CANCELLED'
};

const SOURCE = {
    MANUAL: 'MANUAL',
    LEGACY_PATIENT_DATA: 'LEGACY_PATIENT_DATA'
};

const EVENT = {
    CREATED: 'CREATED',
    UPDATED: 'UPDATED',
    FINALIZED: 'FINALIZED',
    VIEWED: 'VIEWED',
    PRINTED: 'PRINTED',
    CANCELLED: 'CANCELLED',
    CONSENT_LINKED: 'CONSENT_LINKED',
    CONSENT_REFUSED: 'CONSENT_REFUSED'
};

const PERMISSIONS = {
    VIEW: 'clinical_history.view',
    CREATE_DRAFT: 'clinical_history.create_draft',
    EDIT_DRAFT: 'clinical_history.edit_draft',
    FINALIZE: 'clinical_history.finalize',
    CANCEL: 'clinical_history.cancel',
    PRINT: 'clinical_history.print',
    VIEW_SENSITIVE: 'clinical_history.view_sensitive'
};

const FINALIZER_ROLES = ['doctor', 'admin', 'business_admin'];

const parseJson = (value, fallback = null) => {
    if (!value) {
        return fallback;
    }

    if (typeof value === 'object') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
};

const stringifyJson = (value) => {
    if (typeof value === 'string') {
        JSON.parse(value);
        return value;
    }

    return JSON.stringify(value || {});
};

class ClinicalHistoryDao {
    async hasPermission(idLogin, permission) {
        if (!idLogin || !permission) {
            return false;
        }

        const result = await sequelize.query(
            `SELECT 1
               FROM login l
              INNER JOIN permission_rol pr ON ${collateEq('pr.id_rol', 'l.id_rol')} AND pr.active = 1
              INNER JOIN cat_permission cp ON ${collateEq('cp.id_cat_permission', 'pr.id_cat_permission')}
              WHERE ${collateEq('l.id_login', ':_id_login')}
                AND ${collateEq('cp.code', ':_permission')}
                AND l.active = 1
                AND cp.active = 1
                AND cp.is_active = 1
              LIMIT 1`,
            {
                replacements: { _id_login: idLogin, _permission: permission },
                type: QueryTypes.SELECT
            }
        );

        return result.length > 0;
    }

    async getPatient(patientId, businessId, transaction = null) {
        const rows = await sequelize.query(
            `SELECT p.id_person, p.id_business, p.name, p.surname,
                    CONCAT(COALESCE(p.name, ''), ' ', COALESCE(p.surname, '')) AS full_name,
                    p.birthday, p.age, p.local_telephone, p.telephone,
                    a.direction, a.residence, a.cp
               FROM person p
          LEFT JOIN address a
                 ON ${collateEq('a.id_person', 'p.id_person')}
                AND ${collateEq('a.id_business', 'p.id_business')}
                AND a.last = 1
              WHERE ${collateEq('p.id_person', ':_id_person')}
                AND ${collateEq('p.id_business', ':_id_business')}
                AND p.active = 1
              LIMIT 1`,
            {
                replacements: { _id_person: patientId, _id_business: businessId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] || null;
    }

    async getDoctorProfile(businessId, userId, transaction = null) {
        const rows = await sequelize.query(
            `SELECT l.id_login, l.name AS user_name, r.code AS rol,
                    dpp.id_doctor_professional_profile,
                    dpp.professional_name,
                    dpp.professional_license,
                    dpp.specialty,
                    dpp.specialty_license,
                    dpp.is_active AS professional_profile_active
               FROM login l
              INNER JOIN rol r ON ${collateEq('r.id_rol', 'l.id_rol')}
               LEFT JOIN doctor_professional_profile dpp
                 ON ${collateEq('dpp.id_login', 'l.id_login')}
                AND ${collateEq('dpp.id_business', 'l.id_business')}
              WHERE ${collateEq('l.id_login', ':_id_login')}
                AND ${collateEq('l.id_business', ':_id_business')}
                AND l.active = 1
              LIMIT 1`,
            {
                replacements: { _id_login: userId, _id_business: businessId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] || null;
    }

    async getBusiness(businessId, transaction = null) {
        const rows = await sequelize.query(
            `SELECT id_business, name, legal_name AS legalName, email, phone, address, logo_url AS logoUrl
               FROM business
              WHERE ${collateEq('id_business', ':_id_business')}
                AND active = 1
              LIMIT 1`,
            {
                replacements: { _id_business: businessId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] || null;
    }

    async getDoctorForHistory(history, transaction = null) {
        if (!history || (!history.doctor_responsible_profile_id && !history.doctor_responsible_user_id)) {
            return null;
        }

        const rows = await sequelize.query(
            `SELECT l.id_login, l.name AS user_name,
                    dpp.id_doctor_professional_profile,
                    dpp.professional_name,
                    dpp.professional_license,
                    dpp.specialty,
                    dpp.specialty_license,
                    dpp.is_active AS professional_profile_active
               FROM login l
          LEFT JOIN doctor_professional_profile dpp
                 ON ${collateEq('dpp.id_login', 'l.id_login')}
                AND ${collateEq('dpp.id_business', 'l.id_business')}
              WHERE ${collateEq('l.id_business', ':_id_business')}
                AND l.active = 1
                AND (
                    ${collateEq('l.id_login', ':_doctor_user_id')}
                    OR ${collateEq('dpp.id_doctor_professional_profile', ':_doctor_profile_id')}
                )
              LIMIT 1`,
            {
                replacements: {
                    _id_business: history.business_id,
                    _doctor_user_id: history.doctor_responsible_user_id || '',
                    _doctor_profile_id: history.doctor_responsible_profile_id || ''
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] || null;
    }

    async getConsentDocumentById(documentId, businessId, patientId, transaction = null) {
        if (!documentId) {
            return null;
        }

        const rows = await sequelize.query(
            `SELECT id_patient_document, status, signed_at, refusal_reason, created_at
               FROM patient_documents
              WHERE ${collateEq('id_patient_document', ':_document_id')}
                AND ${collateEq('id_business', ':_business_id')}
                AND ${collateEq('id_person', ':_patient_id')}
                AND active = 1
              LIMIT 1`,
            {
                replacements: {
                    _document_id: documentId,
                    _business_id: businessId,
                    _patient_id: patientId
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] || null;
    }

    async resolveResponsibleDoctor(body, transaction = null) {
        const doctorUserId = body.doctor_responsible_user_id || null;
        if (!doctorUserId) {
            return { doctorUserId: null, doctorProfileId: null };
        }

        const profile = await this.getDoctorProfile(body.id_business, doctorUserId, transaction);
        if (!profile || !profile.id_doctor_professional_profile || Number(profile.professional_profile_active) !== 1) {
            return { error: responseData.bad_request('El doctor responsable no tiene perfil profesional activo en este negocio.') };
        }

        return {
            doctorUserId,
            doctorProfileId: profile.id_doctor_professional_profile
        };
    }

    async validateFinalizer(body, transaction = null) {
        const canFinalize = await this.hasPermission(body.id_login, PERMISSIONS.FINALIZE);
        if (!canFinalize) {
            return { error: responseData.unauthorized('No tienes permiso para finalizar historias clinicas.') };
        }

        const profile = await this.getDoctorProfile(body.id_business, body.id_login, transaction);
        const role = profile && profile.rol ? String(profile.rol).toLowerCase() : '';
        if (!profile || !FINALIZER_ROLES.includes(role)) {
            return { error: responseData.unauthorized('Solo un doctor o administrador puede finalizar historias clinicas.') };
        }

        if (!profile.id_doctor_professional_profile || Number(profile.professional_profile_active) !== 1) {
            return { error: responseData.bad_request('Para finalizar la historia clinica, el usuario debe tener perfil profesional activo.') };
        }

        return { profile };
    }

    async getSensitiveConsent(patientId, businessId, transaction = null) {
        const rows = await sequelize.query(
            `SELECT id_patient_document, status, signed_at, refusal_reason, created_at
               FROM patient_documents
              WHERE ${collateEq('id_business', ':_id_business')}
                AND ${collateEq('id_person', ':_id_person')}
                AND document_type = 'SENSITIVE_DATA_CONSENT'
                AND active = 1
                AND status <> 'CANCELADO'
              ORDER BY
                CASE status
                  WHEN 'NO_FIRMADO_POR_NEGATIVA' THEN 1
                  WHEN 'FIRMADO' THEN 2
                  WHEN 'PENDIENTE_FIRMA' THEN 3
                  WHEN 'BORRADOR' THEN 4
                  ELSE 5
                END,
                created_at DESC
              LIMIT 1`,
            {
                replacements: { _id_business: businessId, _id_person: patientId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        const document = rows[0] || null;
        return {
            document,
            status: document ? document.status : 'SIN_CONSENTIMIENTO',
            signedDocument: document && document.status === 'FIRMADO' ? document : null,
            refusalDocument: document && document.status === 'NO_FIRMADO_POR_NEGATIVA' ? document : null
        };
    }

    async addEvent(historyId, businessId, patientId, userId, eventType, metadata = null, transaction = null) {
        await sequelize.query(
            `INSERT INTO clinical_history_events (
                id_clinical_history_event, clinical_history_id, business_id, patient_id,
                event_type, user_id, metadata_json, created_at
            ) VALUES (
                :_id_event, :_history_id, :_business_id, :_patient_id,
                :_event_type, :_user_id, :_metadata_json, NOW()
            )`,
            {
                replacements: {
                    _id_event: uuidv4(),
                    _history_id: historyId,
                    _business_id: businessId,
                    _patient_id: patientId,
                    _event_type: eventType,
                    _user_id: userId || null,
                    _metadata_json: metadata ? JSON.stringify(metadata) : null
                },
                type: QueryTypes.INSERT,
                transaction
            }
        );
    }

    hydrate(history) {
        if (!history) {
            return null;
        }

        return {
            ...history,
            clinical_snapshot_json: parseJson(history.clinical_snapshot_json, {}),
            template_snapshot_json: parseJson(history.template_snapshot_json, null)
        };
    }

    async getHistoryById(id, businessId, transaction = null) {
        const rows = await sequelize.query(
            `SELECT *
               FROM clinical_histories
              WHERE ${collateEq('id_clinical_history', ':_id_clinical_history')}
                AND ${collateEq('business_id', ':_business_id')}
                AND deleted_at IS NULL
              LIMIT 1`,
            {
                replacements: { _id_clinical_history: id, _business_id: businessId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] || null;
    }

    async nextVersion(patientId, businessId, transaction = null) {
        const rows = await sequelize.query(
            `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
               FROM clinical_histories
              WHERE ${collateEq('business_id', ':_business_id')}
                AND ${collateEq('patient_id', ':_patient_id')}
                AND deleted_at IS NULL`,
            {
                replacements: { _business_id: businessId, _patient_id: patientId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] ? Number(rows[0].next_version) : 1;
    }

    async resolveTemplateSnapshot(businessId, transaction = null) {
        try {
            const current = await ClinicalHistoryTemplateDao.getCurrentTemplateForBusiness(businessId, transaction);
            if (!current || !current.template) {
                return { templateVersionId: null, templateSnapshotJson: null };
            }

            return {
                templateVersionId: current.template.id_clinical_history_template_version || null,
                templateSnapshotJson: JSON.stringify(current.template.schema_json || {})
            };
        } catch (error) {
            return { templateVersionId: null, templateSnapshotJson: null };
        }
    }

    isEmptyClinicalValue(value, fieldType = 'text') {
        if (fieldType === 'multiselect') {
            return !Array.isArray(value) || value.length === 0;
        }

        if (fieldType === 'boolean') {
            return value !== true && value !== false;
        }

        if (fieldType === 'checkbox') {
            return value !== true;
        }

        if (value === null || value === undefined) {
            return true;
        }

        if (typeof value === 'string') {
            return value.trim() === '';
        }

        return false;
    }

    validateRequiredFieldsFromTemplate(history) {
        const snapshot = parseJson(history.clinical_snapshot_json, {});
        const schema = parseJson(history.template_snapshot_json, null);

        if (!schema || !Array.isArray(schema.sections)) {
            return this.validateMinimumClinicalFields(snapshot, 'La plantilla de esta historia no es valida. ');
        }

        const missing = [];
        schema.sections
            .filter((section) => section && section.enabled !== false)
            .forEach((section) => {
                const sectionValues = snapshot && snapshot[section.key] && typeof snapshot[section.key] === 'object'
                    ? snapshot[section.key]
                    : {};
                const fields = Array.isArray(section.fields) ? section.fields : [];

                fields
                    .filter((field) => field && field.enabled !== false && field.required === true)
                    .forEach((field) => {
                        if (field.type === 'readonly' && field.source) {
                            return;
                        }

                        const value = sectionValues[field.key];
                        if (this.isEmptyClinicalValue(value, field.type || 'text')) {
                            missing.push(field.label || field.key || 'Campo requerido');
                        }
                    });
            });

        if (missing.length) {
            return {
                ok: false,
                message: `No puedes finalizar la historia clinica. Completa los campos requeridos: ${missing.join(', ')}.`,
                missing
            };
        }

        return { ok: true, missing: [] };
    }

    validateMinimumClinicalFields(snapshot, prefix = '') {
        const missing = [];
        const consultation = snapshot.consultation || {};
        const familyHistory = snapshot.family_history || {};
        const pathologicalHistory = snapshot.pathological_history || {};
        const allergiesMedications = snapshot.allergies_medications || {};
        const physicalExam = snapshot.physical_exam || {};
        const diagnosis = snapshot.diagnosis || {};
        const therapeuticPlan = snapshot.therapeutic_plan || {};

        if (this.isEmptyClinicalValue(consultation.reason)) missing.push('Motivo de consulta');
        if (this.isEmptyClinicalValue(consultation.current_condition)) missing.push('Padecimiento actual');
        if (
            this.isEmptyClinicalValue(familyHistory.relevant) &&
            this.isEmptyClinicalValue(pathologicalHistory.current_or_previous_diseases)
        ) {
            missing.push('Antecedentes relevantes');
        }
        if (this.isEmptyClinicalValue(allergiesMedications.allergies)) missing.push('Alergias');
        if (this.isEmptyClinicalValue(physicalExam.general)) missing.push('Exploracion fisica');
        if (this.isEmptyClinicalValue(diagnosis.initial_diagnosis)) missing.push('Diagnostico inicial');
        if (
            this.isEmptyClinicalValue(therapeuticPlan.initial_plan) &&
            this.isEmptyClinicalValue(therapeuticPlan.initial_indications)
        ) {
            missing.push('Plan inicial');
        }

        if (missing.length) {
            return {
                ok: false,
                message: `${prefix}No puedes finalizar la historia clinica. Completa los campos requeridos: ${missing.join(', ')}.`,
                missing
            };
        }

        return { ok: true, missing: [] };
    }

    async getLatestByPatient(body) {
        try {
            const canView = await this.hasPermission(body.id_login, PERMISSIONS.VIEW);
            if (!canView) {
                return responseData.unauthorized('No tienes permiso para consultar historias clinicas.');
            }

            const patient = await this.getPatient(body.patient_id, body.id_business);
            if (!patient) {
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const rows = await sequelize.query(
                `SELECT *
                   FROM clinical_histories
                  WHERE ${collateEq('business_id', ':_business_id')}
                    AND ${collateEq('patient_id', ':_patient_id')}
                    AND status <> :_cancelled
                    AND deleted_at IS NULL
                  ORDER BY version_number DESC, created_at DESC
                  LIMIT 1`,
                {
                    replacements: {
                        _business_id: body.id_business,
                        _patient_id: body.patient_id,
                        _cancelled: STATUS.CANCELLED
                    },
                    type: QueryTypes.SELECT
                }
            );

            const history = rows[0] || null;
            if (history) {
                await this.addEvent(history.id_clinical_history, body.id_business, history.patient_id, body.id_login, EVENT.VIEWED, { context: 'patient_latest' });
            }

            const consent = await this.getSensitiveConsent(body.patient_id, body.id_business);
            return responseData.success({
                patient,
                history: this.hydrate(history),
                consent_status: consent.status,
                consent_document_id: consent.document ? consent.document.id_patient_document : null
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async listVersionsByPatient(body) {
        try {
            const canView = await this.hasPermission(body.id_login, PERMISSIONS.VIEW);
            if (!canView) {
                return responseData.unauthorized('No tienes permiso para consultar versiones de historia clinica.');
            }

            const patient = await this.getPatient(body.patient_id, body.id_business);
            if (!patient) {
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const rows = await sequelize.query(
                `SELECT ch.id_clinical_history,
                        ch.version_number,
                        ch.status,
                        ch.source,
                        ch.created_at,
                        ch.updated_at,
                        ch.finalized_at,
                        ch.doctor_responsible_user_id,
                        ch.doctor_responsible_profile_id,
                        COALESCE(dpp.professional_name, dl.name) AS doctor_name_snapshot,
                        ch.created_by_user_id,
                        ch.finalized_by_user_id,
                        ch.template_version_id,
                        cht.name AS template_name,
                        chtv.version_number AS template_version_number,
                        ch.consent_document_id,
                        pd.status AS consent_status,
                        CASE
                          WHEN ch.status = 'DRAFT' THEN 'Borrador editable'
                          WHEN ch.status = 'FINALIZED' THEN 'Historia finalizada'
                          WHEN ch.status = 'INCOMPLETE' THEN 'Historia incompleta'
                          WHEN ch.status = 'CANCELLED' THEN 'Historia cancelada'
                          WHEN ch.status = 'SUPERSEDED' THEN 'Version historica'
                          ELSE 'Historia clinica'
                        END AS summary_short
                   FROM clinical_histories ch
              LEFT JOIN login dl
                     ON ${collateEq('dl.id_login', 'ch.doctor_responsible_user_id')}
              LEFT JOIN doctor_professional_profile dpp
                     ON ${collateEq('dpp.id_doctor_professional_profile', 'ch.doctor_responsible_profile_id')}
              LEFT JOIN clinical_history_template_versions chtv
                     ON ${collateEq('chtv.id_clinical_history_template_version', 'ch.template_version_id')}
              LEFT JOIN clinical_history_templates cht
                     ON ${collateEq('cht.id_clinical_history_template', 'chtv.clinical_history_template_id')}
              LEFT JOIN patient_documents pd
                     ON ${collateEq('pd.id_patient_document', 'ch.consent_document_id')}
                    AND pd.active = 1
                  WHERE ${collateEq('ch.business_id', ':_business_id')}
                    AND ${collateEq('ch.patient_id', ':_patient_id')}
                    AND ch.deleted_at IS NULL
                  ORDER BY ch.version_number DESC, ch.created_at DESC`,
                {
                    replacements: {
                        _business_id: body.id_business,
                        _patient_id: body.patient_id
                    },
                    type: QueryTypes.SELECT
                }
            );

            return responseData.success({
                patient,
                versions: rows
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async getById(body) {
        try {
            const canView = await this.hasPermission(body.id_login, PERMISSIONS.VIEW);
            if (!canView) {
                return responseData.unauthorized('No tienes permiso para consultar historias clinicas.');
            }

            const history = await this.getHistoryById(body.id_clinical_history, body.id_business);
            if (!history) {
                return responseData.bad_request('Historia clinica no encontrada.');
            }

            const patient = await this.getPatient(history.patient_id, body.id_business);
            if (!patient) {
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            await this.addEvent(history.id_clinical_history, body.id_business, history.patient_id, body.id_login, EVENT.VIEWED, { context: 'detail' });
            const consent = await this.getSensitiveConsent(history.patient_id, body.id_business);
            const business = await this.getBusiness(body.id_business);
            const doctor = await this.getDoctorForHistory(history);
            const linkedConsent = await this.getConsentDocumentById(history.consent_document_id, body.id_business, history.patient_id);

            return responseData.success({
                patient,
                business,
                doctor,
                history: this.hydrate(history),
                consent_document: linkedConsent,
                consent_status: consent.status,
                consent_document_id: consent.document ? consent.document.id_patient_document : null
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async createDraft(body) {
        const transaction = await sequelize.transaction();
        try {
            const canCreate = await this.hasPermission(body.id_login, PERMISSIONS.CREATE_DRAFT);
            if (!canCreate) {
                await transaction.rollback();
                return responseData.unauthorized('No tienes permiso para crear borradores de historia clinica.');
            }

            const patient = await this.getPatient(body.patient_id, body.id_business, transaction);
            if (!patient) {
                await transaction.rollback();
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const existingDraft = await sequelize.query(
                `SELECT id_clinical_history
                   FROM clinical_histories
                  WHERE ${collateEq('business_id', ':_business_id')}
                    AND ${collateEq('patient_id', ':_patient_id')}
                    AND status = :_status
                    AND deleted_at IS NULL
                  LIMIT 1`,
                {
                    replacements: {
                        _business_id: body.id_business,
                        _patient_id: body.patient_id,
                        _status: STATUS.DRAFT
                    },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            if (existingDraft[0]) {
                await transaction.rollback();
                return responseData.bad_request('Ya existe un borrador activo de historia clinica para este paciente.');
            }

            const doctorResult = await this.resolveResponsibleDoctor(body, transaction);
            if (doctorResult.error) {
                await transaction.rollback();
                return doctorResult.error;
            }

            const historyId = uuidv4();
            const versionNumber = await this.nextVersion(body.patient_id, body.id_business, transaction);
            const source = Object.values(SOURCE).includes(body.source) ? body.source : SOURCE.MANUAL;
            const snapshot = stringifyJson(body.clinical_snapshot_json);
            const templateSnapshot = await this.resolveTemplateSnapshot(body.id_business, transaction);

            await sequelize.query(
                `INSERT INTO clinical_histories (
                    id_clinical_history, business_id, patient_id,
                    doctor_responsible_profile_id, doctor_responsible_user_id,
                    created_by_user_id, updated_by_user_id, finalized_by_user_id,
                    status, version_number, source, consent_document_id,
                    template_version_id, template_snapshot_json, clinical_snapshot_json,
                    finalized_at, created_at, updated_at, deleted_at
                ) VALUES (
                    :_id_clinical_history, :_business_id, :_patient_id,
                    :_doctor_profile_id, :_doctor_user_id,
                    :_created_by, NULL, NULL,
                    :_status, :_version_number, :_source, NULL,
                    :_template_version_id, :_template_snapshot_json, :_clinical_snapshot_json,
                    NULL, NOW(), NOW(), NULL
                )`,
                {
                    replacements: {
                        _id_clinical_history: historyId,
                        _business_id: body.id_business,
                        _patient_id: body.patient_id,
                        _doctor_profile_id: doctorResult.doctorProfileId,
                        _doctor_user_id: doctorResult.doctorUserId,
                        _created_by: body.id_login,
                        _status: STATUS.DRAFT,
                        _version_number: versionNumber,
                        _source: source,
                        _template_version_id: templateSnapshot.templateVersionId,
                        _template_snapshot_json: templateSnapshot.templateSnapshotJson,
                        _clinical_snapshot_json: snapshot
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            await this.addEvent(historyId, body.id_business, body.patient_id, body.id_login, EVENT.CREATED, {
                source,
                template_version_id: templateSnapshot.templateVersionId || null
            }, transaction);
            await transaction.commit();

            return this.getById({ id_clinical_history: historyId, id_business: body.id_business, id_login: body.id_login });
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async updateDraft(body) {
        const transaction = await sequelize.transaction();
        try {
            const canEdit = await this.hasPermission(body.id_login, PERMISSIONS.EDIT_DRAFT);
            if (!canEdit) {
                await transaction.rollback();
                return responseData.unauthorized('No tienes permiso para editar borradores de historia clinica.');
            }

            const history = await this.getHistoryById(body.id_clinical_history, body.id_business, transaction);
            if (!history) {
                await transaction.rollback();
                return responseData.bad_request('Historia clinica no encontrada.');
            }

            if (history.status !== STATUS.DRAFT) {
                await transaction.rollback();
                return responseData.bad_request('Solo se pueden editar historias clinicas en borrador.');
            }

            const patient = await this.getPatient(history.patient_id, body.id_business, transaction);
            if (!patient) {
                await transaction.rollback();
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const doctorResult = await this.resolveResponsibleDoctor(body, transaction);
            if (doctorResult.error) {
                await transaction.rollback();
                return doctorResult.error;
            }

            const templateSnapshot = history.template_snapshot_json
                ? { templateVersionId: null, templateSnapshotJson: null }
                : await this.resolveTemplateSnapshot(body.id_business, transaction);

            await sequelize.query(
                `UPDATE clinical_histories
                    SET clinical_snapshot_json = :_clinical_snapshot_json,
                        doctor_responsible_user_id = COALESCE(:_doctor_user_id, doctor_responsible_user_id),
                        doctor_responsible_profile_id = COALESCE(:_doctor_profile_id, doctor_responsible_profile_id),
                        template_version_id = COALESCE(template_version_id, :_template_version_id),
                        template_snapshot_json = COALESCE(template_snapshot_json, :_template_snapshot_json),
                        updated_by_user_id = :_updated_by,
                        updated_at = NOW()
                  WHERE ${collateEq('id_clinical_history', ':_id_clinical_history')}
                    AND ${collateEq('business_id', ':_business_id')}
                    AND status = :_status`,
                {
                    replacements: {
                        _id_clinical_history: body.id_clinical_history,
                        _business_id: body.id_business,
                        _status: STATUS.DRAFT,
                        _clinical_snapshot_json: stringifyJson(body.clinical_snapshot_json),
                        _doctor_user_id: doctorResult.doctorUserId,
                        _doctor_profile_id: doctorResult.doctorProfileId,
                        _template_version_id: templateSnapshot.templateVersionId,
                        _template_snapshot_json: templateSnapshot.templateSnapshotJson,
                        _updated_by: body.id_login
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await this.addEvent(history.id_clinical_history, body.id_business, history.patient_id, body.id_login, EVENT.UPDATED, null, transaction);
            await transaction.commit();

            return this.getById({ id_clinical_history: history.id_clinical_history, id_business: body.id_business, id_login: body.id_login });
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_UPDATE_ERROR);
        }
    }

    async finalize(body) {
        const transaction = await sequelize.transaction();
        try {
            const history = await this.getHistoryById(body.id_clinical_history, body.id_business, transaction);
            if (!history) {
                await transaction.rollback();
                return responseData.bad_request('Historia clinica no encontrada.');
            }

            if (history.status !== STATUS.DRAFT) {
                await transaction.rollback();
                return responseData.bad_request('Solo se pueden finalizar historias clinicas en borrador.');
            }

            const patient = await this.getPatient(history.patient_id, body.id_business, transaction);
            if (!patient) {
                await transaction.rollback();
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const finalizer = await this.validateFinalizer(body, transaction);
            if (finalizer.error) {
                await transaction.rollback();
                return finalizer.error;
            }

            const requiredValidation = this.validateRequiredFieldsFromTemplate(history);
            if (!requiredValidation.ok) {
                await transaction.rollback();
                return responseData.bad_request(requiredValidation.message);
            }

            const consent = await this.getSensitiveConsent(history.patient_id, body.id_business, transaction);
            if (consent.refusalDocument) {
                await sequelize.query(
                    `UPDATE clinical_histories
                        SET status = :_status,
                            consent_document_id = :_consent_document_id,
                            doctor_responsible_user_id = COALESCE(doctor_responsible_user_id, :_doctor_user_id),
                            doctor_responsible_profile_id = COALESCE(doctor_responsible_profile_id, :_doctor_profile_id),
                            updated_by_user_id = :_updated_by,
                            updated_at = NOW()
                      WHERE ${collateEq('id_clinical_history', ':_id_clinical_history')}
                        AND ${collateEq('business_id', ':_business_id')}`,
                    {
                        replacements: {
                            _id_clinical_history: history.id_clinical_history,
                            _business_id: body.id_business,
                            _status: STATUS.INCOMPLETE,
                            _consent_document_id: consent.refusalDocument.id_patient_document,
                            _doctor_user_id: body.id_login,
                            _doctor_profile_id: finalizer.profile.id_doctor_professional_profile,
                            _updated_by: body.id_login
                        },
                        type: QueryTypes.UPDATE,
                        transaction
                    }
                );
                await this.addEvent(history.id_clinical_history, body.id_business, history.patient_id, body.id_login, EVENT.CONSENT_REFUSED, {
                    consent_document_id: consent.refusalDocument.id_patient_document,
                    reason: consent.refusalDocument.refusal_reason || null
                }, transaction);
                await transaction.commit();
                return this.getById({ id_clinical_history: history.id_clinical_history, id_business: body.id_business, id_login: body.id_login });
            }

            if (!consent.signedDocument) {
                await transaction.rollback();
                return responseData.bad_request('No se puede finalizar la historia clinica sin consentimiento de datos personales sensibles firmado.');
            }

            await sequelize.query(
                `UPDATE clinical_histories
                    SET status = :_status,
                        consent_document_id = :_consent_document_id,
                        doctor_responsible_user_id = COALESCE(doctor_responsible_user_id, :_doctor_user_id),
                        doctor_responsible_profile_id = COALESCE(doctor_responsible_profile_id, :_doctor_profile_id),
                        finalized_by_user_id = :_finalized_by,
                        finalized_at = NOW(),
                        updated_by_user_id = :_updated_by,
                        updated_at = NOW()
                  WHERE ${collateEq('id_clinical_history', ':_id_clinical_history')}
                    AND ${collateEq('business_id', ':_business_id')}`,
                {
                    replacements: {
                        _id_clinical_history: history.id_clinical_history,
                        _business_id: body.id_business,
                        _status: STATUS.FINALIZED,
                        _consent_document_id: consent.signedDocument.id_patient_document,
                        _doctor_user_id: body.id_login,
                        _doctor_profile_id: finalizer.profile.id_doctor_professional_profile,
                        _finalized_by: body.id_login,
                        _updated_by: body.id_login
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await this.addEvent(history.id_clinical_history, body.id_business, history.patient_id, body.id_login, EVENT.CONSENT_LINKED, {
                consent_document_id: consent.signedDocument.id_patient_document
            }, transaction);
            await this.addEvent(history.id_clinical_history, body.id_business, history.patient_id, body.id_login, EVENT.FINALIZED, null, transaction);
            await transaction.commit();

            return this.getById({ id_clinical_history: history.id_clinical_history, id_business: body.id_business, id_login: body.id_login });
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_UPDATE_ERROR);
        }
    }

    async markPrinted(body) {
        const transaction = await sequelize.transaction();
        try {
            const canPrint = await this.hasPermission(body.id_login, PERMISSIONS.PRINT);
            const canView = await this.hasPermission(body.id_login, PERMISSIONS.VIEW);
            if (!canPrint && !canView) {
                await transaction.rollback();
                return responseData.unauthorized('No tienes permiso para imprimir historias clinicas.');
            }

            const history = await this.getHistoryById(body.id_clinical_history, body.id_business, transaction);
            if (!history) {
                await transaction.rollback();
                return responseData.bad_request('Historia clinica no encontrada.');
            }

            const patient = await this.getPatient(history.patient_id, body.id_business, transaction);
            if (!patient) {
                await transaction.rollback();
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            await this.addEvent(history.id_clinical_history, body.id_business, history.patient_id, body.id_login, EVENT.PRINTED, {
                printed_by_user_id: body.id_login,
                clinical_history_id: history.id_clinical_history,
                status: history.status,
                version_number: history.version_number
            }, transaction);
            await transaction.commit();

            return responseData.success(true, Messages.DATA_UPDATE_SUCCESSFULLY);
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_UPDATE_ERROR);
        }
    }

    async cancel(body) {
        const transaction = await sequelize.transaction();
        try {
            const canCancel = await this.hasPermission(body.id_login, PERMISSIONS.CANCEL);
            if (!canCancel) {
                await transaction.rollback();
                return responseData.unauthorized('No tienes permiso para cancelar historias clinicas.');
            }

            const history = await this.getHistoryById(body.id_clinical_history, body.id_business, transaction);
            if (!history) {
                await transaction.rollback();
                return responseData.bad_request('Historia clinica no encontrada.');
            }

            if (history.status === STATUS.FINALIZED) {
                await transaction.rollback();
                return responseData.bad_request('No se puede cancelar una historia clinica finalizada.');
            }

            await sequelize.query(
                `UPDATE clinical_histories
                    SET status = :_status,
                        updated_by_user_id = :_updated_by,
                        updated_at = NOW()
                  WHERE ${collateEq('id_clinical_history', ':_id_clinical_history')}
                    AND ${collateEq('business_id', ':_business_id')}`,
                {
                    replacements: {
                        _id_clinical_history: history.id_clinical_history,
                        _business_id: body.id_business,
                        _status: STATUS.CANCELLED,
                        _updated_by: body.id_login
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await this.addEvent(history.id_clinical_history, body.id_business, history.patient_id, body.id_login, EVENT.CANCELLED, { reason: body.reason || null }, transaction);
            await transaction.commit();

            return responseData.success(true, Messages.DATA_UPDATE_SUCCESSFULLY);
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_UPDATE_ERROR);
        }
    }
}

module.exports = new ClinicalHistoryDao();

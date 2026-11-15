const privateImages = require('../../services/aws/privateImages');
const effectivePermissions = require('../../util/effectivePermissions');
const { canReadClinicalHistory } = require('../../domain/clinicalHistory/access');
const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const ClinicalHistoryTemplateDao = require('./clinicalHistoryTemplate.dao');
const PatientAllergyDao = require('./patientAllergy.dao');
const { applyCurrentAllergy, protectAllergyCore, STATUS: ALLERGY_STATUS } = require('../../domain/clinicalHistory/allergyStatus');
const { revisionConflict, professionalSnapshot, historicalIdentityUnavailable } = require('../../domain/clinicalHistory/historyIntegrity');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const collateEq = (left, param) => `${left} COLLATE ${TENANT_COLLATION} = ${param} COLLATE ${TENANT_COLLATION}`;

// Optional metadata must not hide an existing history, or cross tenant boundaries.
const historyWithMetadata = `SELECT ch.*, creator.name AS created_by_name, editor.name AS updated_by_name,
       cht.name AS template_name, chtv.version_number AS template_version_number
  FROM clinical_histories ch
  LEFT JOIN login creator ON ${collateEq('creator.id_login', 'ch.created_by_user_id')}
       AND ${collateEq('creator.id_business', 'ch.business_id')}
  LEFT JOIN login editor ON ${collateEq('editor.id_login', 'ch.updated_by_user_id')}
       AND ${collateEq('editor.id_business', 'ch.business_id')}
  LEFT JOIN clinical_history_template_versions chtv
       ON ${collateEq('chtv.id_clinical_history_template_version', 'ch.template_version_id')}
  LEFT JOIN clinical_history_templates cht
       ON ${collateEq('cht.id_clinical_history_template', 'chtv.clinical_history_template_id')}
       AND (cht.business_id IS NULL OR ${collateEq('cht.business_id', 'ch.business_id')})`;

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
    async lockHistory(history, businessId, transaction) {
        if (!await PatientAllergyDao.lockPatient(history.patient_id, businessId, transaction)) return false;
        const rows = await sequelize.query(`SELECT * FROM clinical_histories WHERE ${collateEq('id_clinical_history', ':id')}
            AND ${collateEq('business_id', ':business')} AND deleted_at IS NULL FOR UPDATE`,
            { replacements: { id: history.id_clinical_history, business: businessId }, type: QueryTypes.SELECT, transaction });
        if (!rows[0]) return false;
        Object.assign(history, rows[0]);
        return true;
    }
    async lockDraft(history, businessId, transaction) {
        return await this.lockHistory(history, businessId, transaction) && history.status === STATUS.DRAFT;
    }
    async hasPermission(idLogin, permission, transaction = null) {
        return effectivePermissions.hasPermission(idLogin, permission, {enabledCatalog:true, transaction});
    }

    async getPatient(patientId, businessId, transaction = null, includeArchived = false) {
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
                ${includeArchived ? '' : 'AND p.active = 1'}
              LIMIT 1`,
            {
                replacements: { _id_person: patientId, _id_business: businessId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        if(rows[0]) { const identity=require('./identity.dao');const value=await identity.read('patient',patientId,businessId,transaction);rows[0].identity=identity.view(value.data,value.revision,value.updatedAt); }
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
              LIMIT 1 ${transaction ? 'FOR UPDATE' : ''}`,
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

        if (rows[0]) rows[0].logoUrl = await privateImages.inlineImage(rows[0].logoUrl, businessId);
        return rows[0] || null;
    }

    async getDoctorForHistory(history, transaction = null) {
        if (history && history.status !== STATUS.DRAFT) {
            return parseJson(history.responsible_snapshot_json) || historicalIdentityUnavailable(history.doctor_responsible_user_id, history.doctor_responsible_profile_id);
        }
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
        const canFinalize = await this.hasPermission(body.id_login, PERMISSIONS.FINALIZE, transaction);
        if (!canFinalize) {
            return { error: responseData.forbidden('No tienes permiso para finalizar historias clinicas.') };
        }

        const profile = await this.getDoctorProfile(body.id_business, body.id_login, transaction);
        const role = profile && profile.rol ? String(profile.rol).toLowerCase() : '';
        if (!profile || !FINALIZER_ROLES.includes(role)) {
            return { error: responseData.forbidden('Solo un doctor o administrador puede finalizar historias clinicas.') };
        }

        if (!profile.id_doctor_professional_profile || Number(profile.professional_profile_active) !== 1 || !profile.professional_name || !profile.professional_license) {
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

    hydrate(history, currentAllergy = null) {
        if (!history) {
            return null;
        }

        return {
            ...history,
            revision: Number(history.revision),
            responsible_snapshot_json: parseJson(history.responsible_snapshot_json),
            finalizer_snapshot_json: parseJson(history.finalizer_snapshot_json),
            clinical_snapshot_json: history.status === STATUS.DRAFT && currentAllergy
                ? applyCurrentAllergy(parseJson(history.clinical_snapshot_json, {}), currentAllergy) : parseJson(history.clinical_snapshot_json, {}),
            template_snapshot_json: history.status === STATUS.DRAFT
                ? protectAllergyCore(parseJson(history.template_snapshot_json, null)) : parseJson(history.template_snapshot_json, null)
        };
    }

    async getHistoryById(id, businessId, transaction = null) {
        const rows = await sequelize.query(
            `${historyWithMetadata}
              WHERE ${collateEq('ch.id_clinical_history', ':_id_clinical_history')}
                AND ${collateEq('ch.business_id', ':_business_id')}
                AND ch.deleted_at IS NULL
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
        const current = await ClinicalHistoryTemplateDao.getCurrentTemplateForBusiness(businessId, transaction);
        if (!current || !current.template) {
            return { templateVersionId: null, templateSnapshotJson: null };
        }

        return {
            templateVersionId: current.template.id_clinical_history_template_version || null,
            templateSnapshotJson: JSON.stringify(current.template.schema_json || {})
        };
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
        const allergies = snapshot.allergies_medications || {};
        if (![ALLERGY_STATUS.HAS_ALLERGIES, ALLERGY_STATUS.NONE_KNOWN, ALLERGY_STATUS.UNKNOWN].includes(allergies.allergy_status)) missing.push('Estado de alergias');
        if ([ALLERGY_STATUS.HAS_ALLERGIES, ALLERGY_STATUS.UNKNOWN].includes(allergies.allergy_status) && this.isEmptyClinicalValue(allergies.allergies)) missing.push('Detalle de alergias');
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
                            if (!missing.includes(field.label || field.key)) missing.push(field.label || field.key || 'Campo requerido');
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
        if (![ALLERGY_STATUS.HAS_ALLERGIES, ALLERGY_STATUS.NONE_KNOWN, ALLERGY_STATUS.UNKNOWN].includes(allergiesMedications.allergy_status)) missing.push('Estado de alergias');
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
            if (!await canReadClinicalHistory(permission => this.hasPermission(body.id_login, permission))) {
                return responseData.forbidden('No tienes permiso para consultar historias clinicas.');
            }

            const patient = await this.getPatient(body.patient_id, body.id_business, null, true);
            if (!patient) {
                return responseData.forbidden('Paciente no disponible para esta operacion en el consultorio.');
            }

            const rows = await sequelize.query(
                `${historyWithMetadata}
                  WHERE ${collateEq('ch.business_id', ':_business_id')}
                    AND ${collateEq('ch.patient_id', ':_patient_id')}
                    AND ch.status <> :_cancelled
                    AND ch.deleted_at IS NULL
                  ORDER BY ch.version_number DESC, ch.created_at DESC
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
                history: this.hydrate(history, await PatientAllergyDao.getCurrent(history ? history.patient_id : body.patient_id, body.id_business)),
                consent_status: consent.status,
                consent_document_id: consent.document ? consent.document.id_patient_document : null
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async listVersionsByPatient(body) {
        try {
            if (!await canReadClinicalHistory(permission => this.hasPermission(body.id_login, permission))) {
                return responseData.forbidden('No tienes permiso para consultar versiones de historia clinica.');
            }

            const patient = await this.getPatient(body.patient_id, body.id_business, null, true);
            if (!patient) {
                return responseData.forbidden('Paciente no disponible para esta operacion en el consultorio.');
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
                        ch.responsible_snapshot_json,
                        ch.finalizer_snapshot_json,
                        CASE WHEN ch.status = 'DRAFT' THEN COALESCE(dpp.professional_name, dl.name) ELSE NULL END AS current_doctor_name,
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
                    AND ${collateEq('dl.id_business', 'ch.business_id')}
              LEFT JOIN doctor_professional_profile dpp
                     ON ${collateEq('dpp.id_doctor_professional_profile', 'ch.doctor_responsible_profile_id')}
                    AND ${collateEq('dpp.id_business', 'ch.business_id')}
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
                versions: rows.map(row => ({ ...row, doctor_name_snapshot: parseJson(row.responsible_snapshot_json, {}).professional_name || row.current_doctor_name || 'Identidad historica no disponible' }))
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async getById(body, transaction = null) {
        try {
            if (!await canReadClinicalHistory(permission => this.hasPermission(body.id_login, permission, transaction))) {
                return responseData.forbidden('No tienes permiso para consultar historias clinicas.');
            }

            const history = await this.getHistoryById(body.id_clinical_history, body.id_business, transaction);
            if (!history) {
                return responseData.bad_request('Historia clinica no encontrada.');
            }

            const patient = await this.getPatient(history.patient_id, body.id_business, transaction, true);
            if (!patient) {
                return responseData.forbidden('Paciente no disponible para esta operacion en el consultorio.');
            }

            await this.addEvent(history.id_clinical_history, body.id_business, history.patient_id, body.id_login, EVENT.VIEWED, { context: 'detail' }, transaction);
            const consent = await this.getSensitiveConsent(history.patient_id, body.id_business, transaction);
            const business = await this.getBusiness(body.id_business, transaction);
            const doctor = await this.getDoctorForHistory(history, transaction);
            const linkedConsent = await this.getConsentDocumentById(history.consent_document_id, body.id_business, history.patient_id, transaction);

            return responseData.success({
                patient,
                business,
                doctor,
                finalizer: parseJson(history.finalizer_snapshot_json) || (history.finalized_by_user_id ? historicalIdentityUnavailable(history.finalized_by_user_id) : null),
                history: this.hydrate(history, await PatientAllergyDao.getCurrent(history.patient_id, body.id_business, transaction)),
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
            const canCreate = await this.hasPermission(body.id_login, PERMISSIONS.CREATE_DRAFT, transaction);
            if (!canCreate) {
                await transaction.rollback();
                return responseData.forbidden('No tienes permiso para crear borradores de historia clinica.');
            }

            if (!await PatientAllergyDao.lockPatient(body.patient_id, body.id_business, transaction)) {
                await transaction.rollback(); return responseData.forbidden('Paciente no disponible en este consultorio.');
            }
            const patient = await this.getPatient(body.patient_id, body.id_business, transaction);
            if (!patient) {
                await transaction.rollback();
                return responseData.forbidden('Paciente no disponible para esta operacion en el consultorio.');
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
            const snapshot = stringifyJson(applyCurrentAllergy(parseJson(body.clinical_snapshot_json, {}), await PatientAllergyDao.getCurrent(body.patient_id, body.id_business, transaction)));
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
            const saved = await this.getById({ id_clinical_history: historyId, id_business: body.id_business, id_login: body.id_login }, transaction);
            if (saved.status !== 200) { await transaction.rollback(); return saved; }
            await transaction.commit();

            return saved;
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async updateDraft(body) {
        const transaction = await sequelize.transaction();
        try {
            const canEdit = await this.hasPermission(body.id_login, PERMISSIONS.EDIT_DRAFT, transaction);
            if (!canEdit) {
                await transaction.rollback();
                return responseData.forbidden('No tienes permiso para editar borradores de historia clinica.');
            }

            const history = await this.getHistoryById(body.id_clinical_history, body.id_business, transaction);
            if (!history) {
                await transaction.rollback();
                return responseData.bad_request('Historia clinica no encontrada.');
            }

            if (history.status !== STATUS.DRAFT) {
                await transaction.rollback();
                return { status: 409, data: { code: 'HISTORY_REVISION_CONFLICT' }, message: 'Esta historia ya no es un borrador editable. Tu captura se conserva; revisa la version actual.' };
            }

            const patient = await this.getPatient(history.patient_id, body.id_business, transaction);
            if (!patient) {
                await transaction.rollback();
                return responseData.forbidden('Paciente no disponible para esta operacion en el consultorio.');
            }

            const templateSnapshot = history.template_snapshot_json
                ? { templateVersionId: null, templateSnapshotJson: null }
                : await this.resolveTemplateSnapshot(body.id_business, transaction);

            if (!await this.lockDraft(history, body.id_business, transaction)) {
                await transaction.rollback(); return { status: 409, data: { code: 'HISTORY_REVISION_CONFLICT' }, message: 'Este borrador cambio en otra sesion. Tu captura se conserva; revisa la version actual.' };
            }
            const conflict = revisionConflict(history, body.expected_revision);
            if (conflict) { await transaction.rollback(); return conflict; }
            const doctorResult = await this.resolveResponsibleDoctor(body, transaction);
            if (doctorResult.error) { await transaction.rollback(); return doctorResult.error; }
            const currentAllergy = await PatientAllergyDao.getCurrent(history.patient_id, body.id_business, transaction);

            await sequelize.query(
                `UPDATE clinical_histories
                    SET clinical_snapshot_json = :_clinical_snapshot_json,
                        doctor_responsible_user_id = COALESCE(:_doctor_user_id, doctor_responsible_user_id),
                        doctor_responsible_profile_id = COALESCE(:_doctor_profile_id, doctor_responsible_profile_id),
                        template_version_id = COALESCE(template_version_id, :_template_version_id),
                        template_snapshot_json = :_template_snapshot_json,
                        updated_by_user_id = :_updated_by,
                        revision = revision + 1,
                        updated_at = NOW()
                  WHERE ${collateEq('id_clinical_history', ':_id_clinical_history')}
                    AND ${collateEq('business_id', ':_business_id')}
                    AND status = :_status`,
                {
                    replacements: {
                        _id_clinical_history: body.id_clinical_history,
                        _business_id: body.id_business,
                        _status: STATUS.DRAFT,
                        _clinical_snapshot_json: stringifyJson(applyCurrentAllergy(parseJson(body.clinical_snapshot_json, {}), currentAllergy)),
                        _doctor_user_id: doctorResult.doctorUserId,
                        _doctor_profile_id: doctorResult.doctorProfileId,
                        _template_version_id: templateSnapshot.templateVersionId,
                        _template_snapshot_json: stringifyJson(protectAllergyCore(parseJson(history.template_snapshot_json || templateSnapshot.templateSnapshotJson, null))),
                        _updated_by: body.id_login
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await this.addEvent(history.id_clinical_history, body.id_business, history.patient_id, body.id_login, EVENT.UPDATED, null, transaction);
            const saved = await this.getById({ id_clinical_history: history.id_clinical_history, id_business: body.id_business, id_login: body.id_login }, transaction);
            if (saved.status !== 200) { await transaction.rollback(); return saved; }
            await transaction.commit();

            return saved;
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_UPDATE_ERROR);
        }
    }

    async finalize(body) {
        const transaction = await sequelize.transaction();
        try {
            // Authorization precedes even the history's existence/state/revision.
            const finalizer = await this.validateFinalizer(body, transaction);
            if (finalizer.error) { await transaction.rollback(); return finalizer.error; }
            const history = await this.getHistoryById(body.id_clinical_history, body.id_business, transaction);
            if (!history) {
                await transaction.rollback();
                return responseData.bad_request('Historia clinica no encontrada.');
            }

            if (history.status !== STATUS.DRAFT) {
                await transaction.rollback();
                return { status: 409, data: { code: 'HISTORY_REVISION_CONFLICT' }, message: 'Esta historia ya no es un borrador. Revisa su version actual antes de continuar.' };
            }

            const patient = await this.getPatient(history.patient_id, body.id_business, transaction);
            if (!patient) {
                await transaction.rollback();
                return responseData.forbidden('Paciente no disponible para esta operacion en el consultorio.');
            }

            if (!await this.lockDraft(history, body.id_business, transaction)) {
                await transaction.rollback(); return { status: 409, data: { code: 'HISTORY_REVISION_CONFLICT' }, message: 'Este borrador cambio en otra sesion. Revisa la version actual antes de finalizar.' };
            }
            const conflict = revisionConflict(history, body.expected_revision);
            if (conflict) { await transaction.rollback(); return conflict; }
            const responsible = history.doctor_responsible_user_id
                ? await this.getDoctorProfile(body.id_business, history.doctor_responsible_user_id, transaction)
                : finalizer.profile;
            if (!responsible || !responsible.id_doctor_professional_profile || Number(responsible.professional_profile_active) !== 1 || !responsible.professional_name || !responsible.professional_license) {
                await transaction.rollback(); return responseData.bad_request('Selecciona un doctor responsable con perfil profesional activo, nombre y cedula antes de finalizar.');
            }
            const capturedAt = new Date().toISOString();
            const responsibleSnapshot = professionalSnapshot(responsible, capturedAt);
            const finalizerSnapshot = professionalSnapshot(finalizer.profile, capturedAt);
            const currentAllergy = await PatientAllergyDao.getCurrent(history.patient_id, body.id_business, transaction);
            history.clinical_snapshot_json = applyCurrentAllergy(parseJson(history.clinical_snapshot_json, {}), currentAllergy);
            history.template_snapshot_json = protectAllergyCore(parseJson(history.template_snapshot_json, null));
            const requiredValidation = this.validateRequiredFieldsFromTemplate(history);
            if (!requiredValidation.ok) {
                await transaction.rollback();
                return responseData.bad_request(requiredValidation.message);
            }

            const consent = await this.getSensitiveConsent(history.patient_id, body.id_business, transaction);
            await sequelize.query(`UPDATE clinical_histories SET clinical_snapshot_json = :snapshot, template_snapshot_json = :schema,
                responsible_snapshot_json = :responsible, finalizer_snapshot_json = :finalizer, revision = revision + 1
                WHERE ${collateEq('id_clinical_history', ':history')} AND ${collateEq('business_id', ':business')} AND status = 'DRAFT'`,
                { replacements: { snapshot: stringifyJson(history.clinical_snapshot_json), schema: stringifyJson(history.template_snapshot_json), responsible: stringifyJson(responsibleSnapshot), finalizer: stringifyJson(finalizerSnapshot), history: history.id_clinical_history, business: body.id_business }, transaction });
            if (consent.refusalDocument) {
                await sequelize.query(
                    `UPDATE clinical_histories
                        SET status = :_status,
                            consent_document_id = :_consent_document_id,
                            doctor_responsible_user_id = :_doctor_user_id,
                            doctor_responsible_profile_id = :_doctor_profile_id,
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
                            _doctor_user_id: responsible.id_login,
                            _doctor_profile_id: responsible.id_doctor_professional_profile,
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
                const saved = await this.getById({ id_clinical_history: history.id_clinical_history, id_business: body.id_business, id_login: body.id_login }, transaction);
                if (saved.status !== 200) { await transaction.rollback(); return saved; }
                await transaction.commit();
                return saved;
            }

            if (!consent.signedDocument) {
                await transaction.rollback();
                return responseData.bad_request('No se puede finalizar la historia clinica sin consentimiento de datos personales sensibles firmado.');
            }

            await sequelize.query(
                `UPDATE clinical_histories
                    SET status = :_status,
                        consent_document_id = :_consent_document_id,
                        doctor_responsible_user_id = :_doctor_user_id,
                        doctor_responsible_profile_id = :_doctor_profile_id,
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
                        _doctor_user_id: responsible.id_login,
                        _doctor_profile_id: responsible.id_doctor_professional_profile,
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
            const saved = await this.getById({ id_clinical_history: history.id_clinical_history, id_business: body.id_business, id_login: body.id_login }, transaction);
            if (saved.status !== 200) { await transaction.rollback(); return saved; }
            await transaction.commit();

            return saved;
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_UPDATE_ERROR);
        }
    }

    async markPrinted(body) {
        const transaction = await sequelize.transaction();
        try {
            const canPrint = await this.hasPermission(body.id_login, PERMISSIONS.PRINT, transaction);
            const canView = await this.hasPermission(body.id_login, PERMISSIONS.VIEW, transaction);
            if (!canPrint && !canView) {
                await transaction.rollback();
                return responseData.forbidden('No tienes permiso para imprimir historias clinicas.');
            }

            const history = await this.getHistoryById(body.id_clinical_history, body.id_business, transaction);
            if (!history) {
                await transaction.rollback();
                return responseData.bad_request('Historia clinica no encontrada.');
            }

            const patient = await this.getPatient(history.patient_id, body.id_business, transaction, true);
            if (!patient) {
                await transaction.rollback();
                return responseData.forbidden('Paciente no disponible para esta operacion en el consultorio.');
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
            const canCancel = await this.hasPermission(body.id_login, PERMISSIONS.CANCEL, transaction);
            if (!canCancel) {
                await transaction.rollback();
                return responseData.forbidden('No tienes permiso para cancelar historias clinicas.');
            }

            const history = await this.getHistoryById(body.id_clinical_history, body.id_business, transaction);
            if (!history) {
                await transaction.rollback();
                return responseData.bad_request('Historia clinica no encontrada.');
            }

            if (!await this.lockHistory(history, body.id_business, transaction)) {
                await transaction.rollback(); return responseData.bad_request('Historia clinica no disponible.');
            }
            const conflict = revisionConflict(history, body.expected_revision);
            if (conflict) { await transaction.rollback(); return conflict; }
            if (![STATUS.DRAFT, STATUS.INCOMPLETE].includes(history.status)) {
                await transaction.rollback();
                return responseData.bad_request('Solo se pueden cancelar borradores o historias incompletas. Las versiones finalizadas se conservan.');
            }

            await sequelize.query(
                `UPDATE clinical_histories
                    SET status = :_status,
                        updated_by_user_id = :_updated_by,
                        revision = revision + 1,
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

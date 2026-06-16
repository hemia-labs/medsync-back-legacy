const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const { resolveDocumentLicenseMetadata } = require('../../util/documentLicensing');
const { assertPlanFeature } = require('../../util/planFeatures');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const collateEq = (left, param) => `${left} COLLATE ${TENANT_COLLATION} = ${param} COLLATE ${TENANT_COLLATION}`;

const PERMISSIONS = {
    VIEW: 'documents.view',
    CREATE: 'documents.create',
    SIGN: 'documents.sign',
    CANCEL: 'documents.cancel',
    CONFIG: 'documents.config'
};

const ASSISTANT_ROLES = ['assistant', 'ASSISTANT', 'reception', 'RECEPTION', 'receptionist', 'RECEPTIONIST'];
const DOCUMENT_TEMPLATE_FEATURES = Object.freeze({
    ADVANCED: 'advanced_documents',
    PREMIUM: 'premium_document_templates'
});
const ADVANCED_DOCUMENT_CATEGORIES = ['advanced_document', 'advanced_consent'];
const PREMIUM_DOCUMENT_CATEGORIES = ['premium_document_template', 'premium_consent_template'];
const ADVANCED_DOCUMENT_SUBTYPES = ['custom_advanced'];
const PREMIUM_DOCUMENT_SUBTYPES = ['custom_premium', 'premium_multi_signature', 'premium_witnesses', 'premium_automation'];

class DocumentDao {
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

    async getPatient(idPerson, idBusiness) {
        const result = await sequelize.query(
            `SELECT id_person, id_business, name, surname, birthday, age, id_signature, name_signature
               FROM person
              WHERE ${collateEq('id_person', ':_id_person')}
                AND ${collateEq('id_business', ':_id_business')}
                AND active = 1
              LIMIT 1`,
            {
                replacements: { _id_person: idPerson, _id_business: idBusiness },
                type: QueryTypes.SELECT
            }
        );

        return result[0] || null;
    }

    async getDoctorProfile(idBusiness, idLogin) {
        const result = await sequelize.query(
            `SELECT dpp.*, l.name AS user_name, r.code AS rol
               FROM doctor_professional_profile dpp
              INNER JOIN login l ON ${collateEq('l.id_login', 'dpp.id_login')}
              INNER JOIN rol r ON ${collateEq('r.id_rol', 'l.id_rol')}
              WHERE ${collateEq('dpp.id_business', ':_id_business')}
                AND ${collateEq('dpp.id_login', ':_id_login')}
                AND l.active = 1
              LIMIT 1`,
            {
                replacements: { _id_business: idBusiness, _id_login: idLogin },
                type: QueryTypes.SELECT
            }
        );

        return result[0] || null;
    }

    async getActor(idLogin) {
        const result = await sequelize.query(
            `SELECT l.id_login, l.name, r.code AS rol
               FROM login l
              INNER JOIN rol r ON ${collateEq('r.id_rol', 'l.id_rol')}
              WHERE ${collateEq('l.id_login', ':_id_login')}
                AND l.active = 1
              LIMIT 1`,
            {
                replacements: { _id_login: idLogin },
                type: QueryTypes.SELECT
            }
        );

        return result[0] || null;
    }

    async resolveDoctor(body, mustSign = false) {
        const actor = await this.getActor(body.id_login);
        const actorRole = actor ? actor.rol : body.rol;
        const doctorLogin = body.responsible_doctor_user_id || null;

        if (!doctorLogin) {
            return { error: responseData.bad_request('Selecciona un doctor responsable para preparar este documento.') };
        }

        if (doctorLogin !== body.id_login) {
            const canManage = await this.hasPermission(body.id_login, 'admin.users');
            const canCreate = await this.hasPermission(body.id_login, PERMISSIONS.CREATE);
            if (!canManage && !canCreate) {
                return { error: responseData.unauthorized('No puedes seleccionar otro doctor responsable.') };
            }
        }

        const profile = await this.getDoctorProfile(body.id_business, doctorLogin);
        if (!profile || profile.is_active === 0) {
            return { error: responseData.bad_request('Para emitir documentos, completa el perfil profesional del doctor en Configuracion > Personal y usuarios > Perfil profesional.') };
        }

        if (!profile.professional_name || !profile.professional_license) {
            return { error: responseData.bad_request('Para emitir documentos, completa el perfil profesional del doctor en Configuracion > Personal y usuarios > Perfil profesional.') };
        }

        if (mustSign && (profile.can_sign_documents !== 1 || !profile.signature_image)) {
            return { error: responseData.bad_request('Para firmar documentos, el doctor debe tener firma profesional y autorizacion para firmar documentos.') };
        }

        return { profile };
    }

    resolveTemplateLicensingMetadata(body) {
        const templateType = body.template_type || 'CUSTOM';
        const resolved = resolveDocumentLicenseMetadata({
            template_type: templateType,
            license_category: body.license_category,
            template_subtype: body.template_subtype,
            is_premium: body.is_premium,
            clinical_legal_safe: body.clinical_legal_safe,
            minimum_plan: body.minimum_plan,
            block_mode: body.block_mode
        });
        const isUnknownTemplateType = resolved.knownTemplateType !== true && templateType !== 'CUSTOM';
        const metadata = isUnknownTemplateType
            ? resolveDocumentLicenseMetadata({ template_type: templateType })
            : resolved;
        const requiresReview = metadata.requiresMetadataBeforeEnforcement === true
            || metadata.licenseCategory === 'unknown'
            || isUnknownTemplateType;

        return {
            _template_type: templateType,
            _license_category: metadata.licenseCategory || 'unknown',
            _template_subtype: metadata.templateSubtype || 'unknown',
            _is_premium: metadata.isPremium === true ? 1 : 0,
            _clinical_legal_safe: metadata.clinicalLegalSafe === true ? 1 : 0,
            _minimum_plan: metadata.minimumPlan || 'basic',
            _block_mode: metadata.blockMode || 'requires_redesign',
            _licensing_review_required: requiresReview ? 1 : 0,
            _licensing_notes: requiresReview
                ? 'Metadata documental requiere revision antes de enforcement.'
                : 'Metadata documental resuelta por backend sin enforcement.'
        };
    }

    getTemplateLicensingFeature(licensingMetadata) {
        if (!licensingMetadata || licensingMetadata._licensing_review_required === 1) {
            return null;
        }

        const category = licensingMetadata._license_category;
        const subtype = licensingMetadata._template_subtype;
        const blockMode = licensingMetadata._block_mode;

        if (blockMode === 'never' || blockMode === 'requires_redesign') {
            return null;
        }

        if (PREMIUM_DOCUMENT_CATEGORIES.includes(category) || PREMIUM_DOCUMENT_SUBTYPES.includes(subtype)) {
            return DOCUMENT_TEMPLATE_FEATURES.PREMIUM;
        }

        if (ADVANCED_DOCUMENT_CATEGORIES.includes(category) || ADVANCED_DOCUMENT_SUBTYPES.includes(subtype)) {
            return DOCUMENT_TEMPLATE_FEATURES.ADVANCED;
        }

        return null;
    }

    async enforceTemplateLicensing(body, licensingMetadata) {
        const feature = this.getTemplateLicensingFeature(licensingMetadata);

        if (!feature) {
            return null;
        }

        const validation = await assertPlanFeature(body.id_business, feature, {
            actorLoginId: body.id_login || null,
            endpoint: '/api/document/template/save',
            method: 'POST',
            action: 'document_template_save',
            templateId: body.id_document_template || null,
            metadata: {
                template_type: licensingMetadata._template_type,
                license_category: licensingMetadata._license_category,
                template_subtype: licensingMetadata._template_subtype,
                block_mode: licensingMetadata._block_mode
            }
        });

        return validation.error || null;
    }

    async listTemplates(body) {
        try {
            const canView = await this.hasPermission(body.id_login, PERMISSIONS.VIEW) || await this.hasPermission(body.id_login, PERMISSIONS.CONFIG);
            if (!canView) {
                return responseData.unauthorized('No tienes permiso para consultar plantillas de documentos.');
            }

            const rows = await sequelize.query(
                `SELECT dt.id_document_template, dt.id_business, dt.template_type, dt.name, dt.description,
                        dt.license_category, dt.template_subtype, dt.is_premium, dt.clinical_legal_safe,
                        dt.minimum_plan, dt.block_mode, dt.licensing_review_required, dt.licensing_notes,
                        dt.requires_patient_signature, dt.requires_tutor_signature, dt.requires_doctor_signature,
                        dt.requires_witness1_signature, dt.requires_witness2_signature, dt.is_active,
                        dtv.id_document_template_version, dtv.version_number, dtv.content_html, dtv.status
                   FROM document_templates dt
                  INNER JOIN document_template_versions dtv
                          ON ${collateEq('dtv.id_document_template', 'dt.id_document_template')}
                         AND dtv.is_current = 1
                  WHERE ${collateEq('dt.id_business', ':_id_business')}
                    AND dt.active = 1
                  ORDER BY dt.template_type, dt.name`,
                {
                    replacements: { _id_business: body.id_business },
                    type: QueryTypes.SELECT
                }
            );

            return responseData.success(rows, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async saveTemplate(body) {
        try {
            const canConfig = await this.hasPermission(body.id_login, PERMISSIONS.CONFIG);
            if (!canConfig) {
                return responseData.unauthorized('No tienes permiso para configurar documentos.');
            }

            const idTemplate = body.id_document_template || uuidv4();
            const existing = body.id_document_template ? await sequelize.query(
                `SELECT id_document_template FROM document_templates
                  WHERE ${collateEq('id_document_template', ':_id_document_template')}
                    AND ${collateEq('id_business', ':_id_business')}
                  LIMIT 1`,
                {
                    replacements: { _id_document_template: body.id_document_template, _id_business: body.id_business },
                    type: QueryTypes.SELECT
                }
            ) : [];

            const flags = {
                _requires_patient_signature: body.requires_patient_signature === false ? 0 : 1,
                _requires_tutor_signature: body.requires_tutor_signature === true ? 1 : 0,
                _requires_doctor_signature: body.requires_doctor_signature === false ? 0 : 1,
                _requires_witness1_signature: body.requires_witness1_signature === true ? 1 : 0,
                _requires_witness2_signature: body.requires_witness2_signature === true ? 1 : 0,
                _is_active: body.is_active === false ? 0 : 1
            };
            const licensingMetadata = this.resolveTemplateLicensingMetadata(body);
            const licensingError = await this.enforceTemplateLicensing(body, licensingMetadata);
            if (licensingError) {
                return licensingError;
            }

            if (existing[0]) {
                await sequelize.query(
                    `UPDATE document_templates
                        SET template_type = :_template_type,
                            license_category = :_license_category,
                            template_subtype = :_template_subtype,
                            is_premium = :_is_premium,
                            clinical_legal_safe = :_clinical_legal_safe,
                            minimum_plan = :_minimum_plan,
                            block_mode = :_block_mode,
                            licensing_review_required = :_licensing_review_required,
                            licensing_notes = :_licensing_notes,
                            name = :_name,
                            description = :_description,
                            requires_patient_signature = :_requires_patient_signature,
                            requires_tutor_signature = :_requires_tutor_signature,
                            requires_doctor_signature = :_requires_doctor_signature,
                            requires_witness1_signature = :_requires_witness1_signature,
                            requires_witness2_signature = :_requires_witness2_signature,
                            is_active = :_is_active,
                            updated_at = NOW(),
                            updated_by = :_id_login
                      WHERE ${collateEq('id_document_template', ':_id_document_template')}
                        AND ${collateEq('id_business', ':_id_business')}`,
                    {
                        replacements: {
                            _id_document_template: idTemplate,
                            _id_business: body.id_business,
                            _name: body.name,
                            _description: body.description || null,
                            _id_login: body.id_login,
                            ...licensingMetadata,
                            ...flags
                        },
                        type: QueryTypes.UPDATE
                    }
                );
                await sequelize.query(
                    `UPDATE document_template_versions
                        SET is_current = 0
                      WHERE ${collateEq('id_document_template', ':_id_document_template')}`,
                    { replacements: { _id_document_template: idTemplate }, type: QueryTypes.UPDATE }
                );
            } else {
                await sequelize.query(
                    `INSERT INTO document_templates (
                        id_document_template, id_business, template_type,
                        license_category, template_subtype, is_premium, clinical_legal_safe,
                        minimum_plan, block_mode, licensing_review_required, licensing_notes,
                        name, description,
                        requires_patient_signature, requires_tutor_signature, requires_doctor_signature,
                        requires_witness1_signature, requires_witness2_signature, is_active,
                        active, created_at, created_by
                    ) VALUES (
                        :_id_document_template, :_id_business, :_template_type,
                        :_license_category, :_template_subtype, :_is_premium, :_clinical_legal_safe,
                        :_minimum_plan, :_block_mode, :_licensing_review_required, :_licensing_notes,
                        :_name, :_description,
                        :_requires_patient_signature, :_requires_tutor_signature, :_requires_doctor_signature,
                        :_requires_witness1_signature, :_requires_witness2_signature, :_is_active,
                        1, NOW(), :_id_login
                    )`,
                    {
                        replacements: {
                            _id_document_template: idTemplate,
                            _id_business: body.id_business,
                            _name: body.name,
                            _description: body.description || null,
                            _id_login: body.id_login,
                            ...licensingMetadata,
                            ...flags
                        },
                        type: QueryTypes.INSERT
                    }
                );
            }

            const version = await sequelize.query(
                `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
                   FROM document_template_versions
                  WHERE ${collateEq('id_document_template', ':_id_document_template')}`,
                {
                    replacements: { _id_document_template: idTemplate },
                    type: QueryTypes.SELECT
                }
            );

            await sequelize.query(
                `INSERT INTO document_template_versions (
                    id_document_template_version, id_document_template, version_number, content_html,
                    status, is_current, created_at, created_by
                ) VALUES (
                    :_id_document_template_version, :_id_document_template, :_version_number, :_content_html,
                    'ACTIVE', 1, NOW(), :_id_login
                )`,
                {
                    replacements: {
                        _id_document_template_version: uuidv4(),
                        _id_document_template: idTemplate,
                        _version_number: version[0].next_version,
                        _content_html: body.content_html || '',
                        _id_login: body.id_login
                    },
                    type: QueryTypes.INSERT
                }
            );

            return this.listTemplates(body);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async listPatientDocuments(body) {
        try {
            const canView = await this.hasPermission(body.id_login, PERMISSIONS.VIEW);
            if (!canView) {
                return responseData.unauthorized('No tienes permiso para consultar documentos.');
            }

            const patient = await this.getPatient(body.id_person, body.id_business);
            if (!patient) {
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const rows = await sequelize.query(
                `SELECT pd.*, dt.name AS template_name, dt.template_type,
                        dt.requires_patient_signature, dt.requires_tutor_signature, dt.requires_doctor_signature,
                        dt.requires_witness1_signature, dt.requires_witness2_signature
                   FROM patient_documents pd
                   LEFT JOIN document_templates dt
                          ON ${collateEq('dt.id_document_template', 'pd.id_document_template')}
                  WHERE ${collateEq('pd.id_business', ':_id_business')}
                    AND ${collateEq('pd.id_person', ':_id_person')}
                    AND pd.active = 1
                  ORDER BY pd.created_at DESC`,
                {
                    replacements: { _id_business: body.id_business, _id_person: body.id_person },
                    type: QueryTypes.SELECT
                }
            );

            const signatures = rows.length > 0 ? await sequelize.query(
                `SELECT id_patient_document, signature_role, signer_name_snapshot, signature_image, signed_at, signed_by_user_id
                   FROM patient_document_signatures
                  WHERE id_patient_document IN (:_ids)
                  ORDER BY signed_at ASC`,
                {
                    replacements: { _ids: rows.map((item) => item.id_patient_document) },
                    type: QueryTypes.SELECT
                }
            ) : [];

            const signaturesByDocument = signatures.reduce((acc, signature) => {
                acc[signature.id_patient_document] = acc[signature.id_patient_document] || [];
                acc[signature.id_patient_document].push(signature);
                return acc;
            }, {});

            const enriched = rows.map((document) => ({
                ...document,
                signatures: signaturesByDocument[document.id_patient_document] || []
            }));

            return responseData.success(enriched, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async getTemplateVersion(idBusiness, idTemplate) {
        const rows = await sequelize.query(
            `SELECT dt.*, dtv.id_document_template_version, dtv.version_number, dtv.content_html
               FROM document_templates dt
              INNER JOIN document_template_versions dtv
                      ON ${collateEq('dtv.id_document_template', 'dt.id_document_template')}
                     AND dtv.is_current = 1
              WHERE ${collateEq('dt.id_business', ':_id_business')}
                AND ${collateEq('dt.id_document_template', ':_id_document_template')}
                AND dt.active = 1
                AND dt.is_active = 1
              LIMIT 1`,
            {
                replacements: { _id_business: idBusiness, _id_document_template: idTemplate },
                type: QueryTypes.SELECT
            }
        );
        return rows[0] || null;
    }

    replaceVariables(html, context) {
        return String(html || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => (
            context[key] === undefined || context[key] === null ? '' : String(context[key])
        ));
    }

    async buildContext(body, patient, doctor) {
        const businessRows = await sequelize.query(
            `SELECT name, legal_name, phone, address
               FROM business
              WHERE ${collateEq('id_business', ':_id_business')}
              LIMIT 1`,
            { replacements: { _id_business: body.id_business }, type: QueryTypes.SELECT }
        );
        const business = businessRows[0] || {};
        const patientName = `${patient.name || ''} ${patient.surname || ''}`.trim();

        return {
            nombrePaciente: patientName,
            edadPaciente: patient.age || '',
            fechaNacimientoPaciente: patient.birthday || '',
            nombreDoctor: doctor.professional_name || '',
            cedulaDoctor: doctor.professional_license || '',
            especialidadDoctor: doctor.specialty || '',
            cedulaEspecialidadDoctor: doctor.specialty_license || '',
            universidadDoctor: doctor.university || '',
            nombreConsultorio: business.legal_name || business.name || '',
            nombreBusiness: business.name || '',
            fechaActual: new Date().toISOString().slice(0, 10),
            diagnostico: body.diagnosis || '',
            planTratamiento: body.treatment_plan || '',
            nombreTutor: body.guardian_name || '',
            parentescoTutor: body.guardian_relationship || ''
        };
    }

    doctorSnapshot(profile) {
        return {
            _responsible_doctor_user_id: profile.id_login,
            _responsible_doctor_profile_id: profile.id_doctor_professional_profile,
            _doctor_name_snapshot: profile.professional_name,
            _professional_license_snapshot: profile.professional_license,
            _university_snapshot: profile.university || null,
            _specialty_snapshot: profile.specialty || null,
            _specialty_license_snapshot: profile.specialty_license || null,
            _professional_phone_snapshot: profile.professional_phone || null,
            _doctor_signature_snapshot: profile.signature_image || null
        };
    }

    async createDocument(body) {
        try {
            const canCreate = await this.hasPermission(body.id_login, PERMISSIONS.CREATE);
            if (!canCreate) {
                return responseData.unauthorized('No tienes permiso para crear documentos.');
            }

            const patient = await this.getPatient(body.id_person, body.id_business);
            if (!patient) {
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const template = await this.getTemplateVersion(body.id_business, body.id_document_template);
            if (!template) {
                return responseData.bad_request('Plantilla no disponible.');
            }

            const existingOpenDocument = await sequelize.query(
                `SELECT id_patient_document, title, status
                   FROM patient_documents
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_person', ':_id_person')}
                    AND ${collateEq('id_document_template', ':_id_document_template')}
                    AND status IN ('BORRADOR', 'PENDIENTE_FIRMA')
                    AND active = 1
                  LIMIT 1`,
                {
                    replacements: {
                        _id_business: body.id_business,
                        _id_person: body.id_person,
                        _id_document_template: template.id_document_template
                    },
                    type: QueryTypes.SELECT
                }
            );

            if (existingOpenDocument[0]) {
                return responseData.bad_request('Ya existe un borrador o documento pendiente de firma de este formato. Continua con el documento existente.');
            }

            if (template.template_type === 'SENSITIVE_DATA_CONSENT') {
                const existingSensitiveConsent = await sequelize.query(
                    `SELECT id_patient_document, title
                       FROM patient_documents
                      WHERE ${collateEq('id_business', ':_id_business')}
                        AND ${collateEq('id_person', ':_id_person')}
                        AND document_type = 'SENSITIVE_DATA_CONSENT'
                        AND status = 'FIRMADO'
                        AND active = 1
                      LIMIT 1`,
                    {
                        replacements: { _id_business: body.id_business, _id_person: body.id_person },
                        type: QueryTypes.SELECT
                    }
                );

                if (existingSensitiveConsent[0] && body.force_new_version !== true) {
                    return responseData.bad_request('Este paciente ya tiene un consentimiento de datos personales sensibles firmado.');
                }
            }

            const doctorResult = await this.resolveDoctor(body, false);
            if (doctorResult.error) {
                return doctorResult.error;
            }

            const context = await this.buildContext(body, patient, doctorResult.profile);
            const html = this.replaceVariables(template.content_html, context);
            const idDocument = uuidv4();
            const snapshot = this.doctorSnapshot(doctorResult.profile);

            await sequelize.query(
                `INSERT INTO patient_documents (
                    id_patient_document, id_business, id_person, id_document_template,
                    id_document_template_version, template_version_number, document_type, origin,
                    status, title, content_html_snapshot, signed_content_html_snapshot,
                    responsible_doctor_user_id, responsible_doctor_profile_id,
                    doctor_name_snapshot, professional_license_snapshot, university_snapshot,
                    specialty_snapshot, specialty_license_snapshot, professional_phone_snapshot,
                    doctor_signature_snapshot, guardian_name_snapshot, guardian_relationship_snapshot,
                    guardian_reason_snapshot, clinical_history_id, treatment_plan_id, appointment_id, created_at, created_by,
                    issued_by_user_id, active
                ) VALUES (
                    :_id_patient_document, :_id_business, :_id_person, :_id_document_template,
                    :_id_document_template_version, :_template_version_number, :_document_type, :_origin,
                    :_status, :_title, :_content_html_snapshot, :_signed_content_html_snapshot,
                    :_responsible_doctor_user_id, :_responsible_doctor_profile_id,
                    :_doctor_name_snapshot, :_professional_license_snapshot, :_university_snapshot,
                    :_specialty_snapshot, :_specialty_license_snapshot, :_professional_phone_snapshot,
                    :_doctor_signature_snapshot, :_guardian_name_snapshot, :_guardian_relationship_snapshot,
                    :_guardian_reason_snapshot, :_clinical_history_id, :_treatment_plan_id, :_appointment_id, NOW(), :_id_login,
                    :_id_login, 1
                )`,
                {
                    replacements: {
                        _id_patient_document: idDocument,
                        _id_business: body.id_business,
                        _id_person: body.id_person,
                        _id_document_template: template.id_document_template,
                        _id_document_template_version: template.id_document_template_version,
                        _template_version_number: template.version_number,
                        _document_type: template.template_type,
                        _origin: body.origin || 'DOCUMENT_CENTER',
                        _status: body.status || 'BORRADOR',
                        _title: body.title || template.name,
                        _content_html_snapshot: html,
                        _signed_content_html_snapshot: null,
                        _guardian_name_snapshot: body.guardian_name || null,
                        _guardian_relationship_snapshot: body.guardian_relationship || null,
                        _guardian_reason_snapshot: body.guardian_reason || null,
                        _clinical_history_id: body.clinical_history_id || null,
                        _treatment_plan_id: body.treatment_plan_id || null,
                        _appointment_id: body.appointment_id || null,
                        _id_login: body.id_login,
                        ...snapshot
                    },
                    type: QueryTypes.INSERT
                }
            );

            await this.addEvent(idDocument, body.id_business, body.id_login, 'CREATED', 'Documento creado.');
            return this.listPatientDocuments(body);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async addEvent(idDocument, idBusiness, idLogin, eventType, notes = null) {
        await sequelize.query(
            `INSERT INTO patient_document_events (
                id_patient_document_event, id_patient_document, id_business, event_type,
                notes, created_at, created_by
            ) VALUES (
                :_id_patient_document_event, :_id_patient_document, :_id_business, :_event_type,
                :_notes, NOW(), :_id_login
            )`,
            {
                replacements: {
                    _id_patient_document_event: uuidv4(),
                    _id_patient_document: idDocument,
                    _id_business: idBusiness,
                    _event_type: eventType,
                    _notes: notes,
                    _id_login: idLogin
                },
                type: QueryTypes.INSERT
            }
        );
    }

    requiredSignatureRoles(document) {
        const roles = [];
        if (document.guardian_name_snapshot || document.requires_tutor_signature === 1) {
            roles.push('TUTOR');
        } else if (document.requires_patient_signature !== 0) {
            roles.push('PATIENT');
        }

        if (document.requires_doctor_signature !== 0) {
            roles.push('DOCTOR');
        }

        if (document.requires_witness1_signature === 1) {
            roles.push('WITNESS1');
        }

        if (document.requires_witness2_signature === 1) {
            roles.push('WITNESS2');
        }

        return roles;
    }

    completedSignatureRoles(document, signatures) {
        const roles = signatures
            .filter((signature) => signature.signature_image || signature.signed_at)
            .map((signature) => signature.signature_role);

        if (document.doctor_signature_snapshot) {
            roles.push('DOCTOR');
        }

        return [...new Set(roles)];
    }

    async updateStatus(body, status, eventType, note) {
        try {
            const permission = status === 'FIRMADO' ? PERMISSIONS.SIGN : PERMISSIONS.CANCEL;
            const allowed = await this.hasPermission(body.id_login, permission);
            if (!allowed) {
                return responseData.unauthorized('No tienes permiso para actualizar este documento.');
            }

            if (status === 'FIRMADO') {
                const doctorResult = await this.resolveDoctor(body, true);
                if (doctorResult.error) {
                    return doctorResult.error;
                }
            }

            const documentRows = await sequelize.query(
                `SELECT pd.id_patient_document, pd.id_person, pd.content_html_snapshot, pd.status,
                        pd.guardian_name_snapshot, pd.doctor_signature_snapshot,
                        dt.requires_patient_signature, dt.requires_tutor_signature, dt.requires_doctor_signature,
                        dt.requires_witness1_signature, dt.requires_witness2_signature
                   FROM patient_documents pd
                   LEFT JOIN document_templates dt
                          ON ${collateEq('dt.id_document_template', 'pd.id_document_template')}
                  WHERE ${collateEq('pd.id_patient_document', ':_id_patient_document')}
                    AND ${collateEq('pd.id_business', ':_id_business')}
                    AND pd.active = 1
                  LIMIT 1`,
                {
                    replacements: { _id_patient_document: body.id_patient_document, _id_business: body.id_business },
                    type: QueryTypes.SELECT
                }
            );

            if (!documentRows[0]) {
                return responseData.bad_request('Documento no encontrado.');
            }

            if (status === 'NO_FIRMADO_POR_NEGATIVA' && documentRows[0].status === 'FIRMADO') {
                return responseData.bad_request('No se puede registrar negativa en un documento ya firmado.');
            }

            if (status === 'FIRMADO' && !['BORRADOR', 'PENDIENTE_FIRMA'].includes(documentRows[0].status)) {
                return responseData.bad_request('Este documento no esta disponible para firma.');
            }

            let finalStatus = status;
            let eventToRegister = eventType;
            let noteToRegister = note;

            if (body.patient_signature) {
                const signatureRole = body.signature_role || 'PATIENT';
                const existingSignatureRows = await sequelize.query(
                    `SELECT signature_role, signature_image, signed_at
                       FROM patient_document_signatures
                      WHERE ${collateEq('id_patient_document', ':_id_patient_document')}
                        AND ${collateEq('id_business', ':_id_business')}`,
                    {
                        replacements: { _id_patient_document: body.id_patient_document, _id_business: body.id_business },
                        type: QueryTypes.SELECT
                    }
                );

                if (existingSignatureRows.some((signature) => signature.signature_role === signatureRole)) {
                    return responseData.bad_request('Esta firma ya fue capturada para el documento.');
                }

                await sequelize.query(
                    `INSERT INTO patient_document_signatures (
                        id_patient_document_signature, id_patient_document, id_business, signature_role,
                        signer_name_snapshot, signature_image, signed_at, signed_by_user_id, created_at, created_by
                    ) VALUES (
                        :_id_patient_document_signature, :_id_patient_document, :_id_business, :_signature_role,
                        :_signer_name_snapshot, :_signature_image, NOW(), :_id_login, NOW(), :_id_login
                    )`,
                    {
                        replacements: {
                            _id_patient_document_signature: uuidv4(),
                            _id_patient_document: body.id_patient_document,
                            _id_business: body.id_business,
                            _signature_role: signatureRole,
                            _signer_name_snapshot: body.signer_name || null,
                            _signature_image: body.patient_signature,
                            _id_login: body.id_login
                        },
                        type: QueryTypes.INSERT
                    }
                );

                if (status === 'FIRMADO') {
                    const requiredRoles = this.requiredSignatureRoles(documentRows[0]);
                    const completedRoles = this.completedSignatureRoles(documentRows[0], [
                        ...existingSignatureRows,
                        { signature_role: signatureRole, signature_image: body.patient_signature, signed_at: new Date() }
                    ]);
                    const hasAllRequiredSignatures = requiredRoles.every((role) => completedRoles.includes(role));
                    finalStatus = hasAllRequiredSignatures ? 'FIRMADO' : 'PENDIENTE_FIRMA';
                    eventToRegister = hasAllRequiredSignatures ? 'SIGNED' : 'SIGNATURE_CAPTURED';
                    noteToRegister = hasAllRequiredSignatures ? 'Documento firmado.' : 'Firma capturada. Quedan firmas pendientes.';
                }
            }

            await sequelize.query(
                `UPDATE patient_documents
                    SET status = :_status,
                        signed_content_html_snapshot = CASE WHEN :_status = 'FIRMADO' THEN content_html_snapshot ELSE signed_content_html_snapshot END,
                        signed_at = CASE WHEN :_status = 'FIRMADO' THEN NOW() ELSE signed_at END,
                        signed_by_user_id = CASE WHEN :_status = 'FIRMADO' THEN :_id_login ELSE signed_by_user_id END,
                        refusal_reason = CASE WHEN :_status = 'NO_FIRMADO_POR_NEGATIVA' THEN :_refusal_reason ELSE refusal_reason END,
                        updated_at = NOW(),
                        updated_by = :_id_login
                  WHERE ${collateEq('id_patient_document', ':_id_patient_document')}
                    AND ${collateEq('id_business', ':_id_business')}`,
                {
                    replacements: {
                        _id_patient_document: body.id_patient_document,
                        _id_business: body.id_business,
                        _status: finalStatus,
                        _id_login: body.id_login,
                        _refusal_reason: body.refusal_reason || null
                    },
                    type: QueryTypes.UPDATE
                }
            );

            await this.addEvent(body.id_patient_document, body.id_business, body.id_login, eventToRegister, noteToRegister || null);
            return this.listPatientDocuments({ id_business: body.id_business, id_login: body.id_login, id_person: documentRows[0].id_person });
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async auditAction(body) {
        try {
            const allowedEvents = ['VIEWED', 'PRINTED', 'SIGNED', 'REFUSAL_REGISTERED'];
            if (!allowedEvents.includes(body.event_type)) {
                return responseData.bad_request('Evento de documento no valido.');
            }

            const canView = await this.hasPermission(body.id_login, PERMISSIONS.VIEW);
            if (!canView) {
                return responseData.unauthorized('No tienes permiso para auditar este documento.');
            }

            const documentRows = await sequelize.query(
                `SELECT id_patient_document
                   FROM patient_documents
                  WHERE ${collateEq('id_patient_document', ':_id_patient_document')}
                    AND ${collateEq('id_business', ':_id_business')}
                    AND active = 1
                  LIMIT 1`,
                {
                    replacements: { _id_patient_document: body.id_patient_document, _id_business: body.id_business },
                    type: QueryTypes.SELECT
                }
            );

            if (!documentRows[0]) {
                return responseData.bad_request('Documento no encontrado.');
            }

            await this.addEvent(body.id_patient_document, body.id_business, body.id_login, body.event_type, body.notes || null);
            return responseData.success(true, Messages.DATA_SAVE_SUCCESSFULLY || 'Evento registrado.');
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }
}

module.exports = new DocumentDao();

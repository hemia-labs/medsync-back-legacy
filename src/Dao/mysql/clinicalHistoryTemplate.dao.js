const effectivePermissions = require('../../util/effectivePermissions');
const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const { ALLOWED_FIELD_TYPES, baseClinicalHistoryTemplate } = require('../../domain/clinicalHistory/clinicalHistoryBaseTemplate');
const { protectAllergyCore } = require('../../domain/clinicalHistory/allergyStatus');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const collateEq = (left, param) => `${left} COLLATE ${TENANT_COLLATION} = ${param} COLLATE ${TENANT_COLLATION}`;
const MAX_SCHEMA_SIZE = 250000;

const PERMISSIONS = {
    VIEW: 'clinical_history_template.view',
    MANAGE: 'clinical_history_template.manage'
};

const EVENT = {
    TEMPLATE_CREATED: 'TEMPLATE_CREATED',
    TEMPLATE_VERSION_CREATED: 'TEMPLATE_VERSION_CREATED',
    TEMPLATE_ACTIVATED: 'TEMPLATE_ACTIVATED',
    TEMPLATE_VIEWED: 'TEMPLATE_VIEWED'
};

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

const stringifySchema = (schema) => {
    if (typeof schema === 'string') {
        JSON.parse(schema);
        return schema;
    }
    return JSON.stringify(schema || {});
};

class ClinicalHistoryTemplateDao {
    async hasPermission(idLogin, permission) {
        return effectivePermissions.hasPermission(idLogin, permission, {enabledCatalog:true});
    }

    hydrate(row) {
        if (!row) {
            return null;
        }

        return {
            ...row,
            is_system_template: Number(row.is_system_template) === 1,
            is_active: Number(row.is_active) === 1,
            schema_json: protectAllergyCore(parseJson(row.schema_json, { sections: [] }))
        };
    }

    validateSchema(schema) {
        const parsed = parseJson(schema, null);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, message: 'El schema_json debe ser un objeto JSON.' };
        }

        const serialized = JSON.stringify(parsed);
        if (serialized.length > MAX_SCHEMA_SIZE) {
            return { ok: false, message: 'El schema_json excede el tamaño máximo permitido.' };
        }

        if (!Array.isArray(parsed.sections)) {
            return { ok: false, message: 'schema_json.sections debe ser un arreglo.' };
        }

        const allergySection = parsed.sections.find(section => section && section.key === 'allergies_medications');
        const allergyStatus = allergySection && Array.isArray(allergySection.fields) && allergySection.fields.find(field => field && field.key === 'allergy_status');
        if (!allergySection || allergySection.enabled !== true || !allergyStatus || allergyStatus.enabled === false || allergyStatus.required !== true || allergyStatus.type !== 'select') {
            return { ok: false, message: 'El estado de alergias es obligatorio del sistema y debe permanecer activo en todas las plantillas.' };
        }

        const lockedSections = (baseClinicalHistoryTemplate.sections || [])
            .filter((section) => section.locked)
            .map((section) => section.key);
        const sectionKeys = new Set();
        const sectionPositions = new Set();
        for (const section of parsed.sections) {
            if (!section || typeof section !== 'object' || Array.isArray(section)) {
                return { ok: false, message: 'Cada sección debe ser un objeto.' };
            }

            if (!section.key || !section.label || section.enabled === undefined || section.order === undefined || !Array.isArray(section.fields)) {
                return { ok: false, message: 'Cada sección requiere key, label, enabled, order y fields.' };
            }

            if (sectionKeys.has(section.key)) {
                return { ok: false, message: `Sección duplicada: ${section.key}` };
            }
            sectionKeys.add(section.key);

            const position = Number(section.order);
            if(typeof section.order === 'boolean' || section.order === null || section.order === '' || !Number.isInteger(position) || position < 1 || position > parsed.sections.length || sectionPositions.has(position)) {
                return { ok:false, message:'Cada sección debe tener una posición entera distinta, entre 1 y el total de secciones.' };
            }
            sectionPositions.add(position);

            const fieldKeys = new Set();
            for (const field of section.fields) {
                if (!field || typeof field !== 'object' || Array.isArray(field)) {
                    return { ok: false, message: `Campo inválido en sección ${section.key}.` };
                }

                if (!field.key || !field.label || !field.type || field.required === undefined) {
                    return { ok: false, message: `Cada campo de ${section.key} requiere key, label, type y required.` };
                }

                if (!ALLOWED_FIELD_TYPES.includes(field.type)) {
                    return { ok: false, message: `Tipo de campo no permitido: ${field.type}` };
                }

                if (fieldKeys.has(field.key)) {
                    return { ok: false, message: `Campo duplicado en ${section.key}: ${field.key}` };
                }
                fieldKeys.add(field.key);
            }
        }

        const missingLockedSection = lockedSections.find((key) => !sectionKeys.has(key));
        if (missingLockedSection) {
            return { ok: false, message: `No se puede eliminar la sección obligatoria del sistema: ${missingLockedSection}` };
        }

        return { ok: true, schema: protectAllergyCore(parsed) };
    }

    async addEvent(templateId, businessId, userId, eventType, metadata = null, transaction = null) {
        await sequelize.query(
            `INSERT INTO clinical_history_template_events (
                id_clinical_history_template_event, clinical_history_template_id,
                business_id, event_type, user_id, metadata_json, created_at
            ) VALUES (
                :_id_event, :_template_id, :_business_id, :_event_type,
                :_user_id, :_metadata_json, NOW()
            )`,
            {
                replacements: {
                    _id_event: uuidv4(),
                    _template_id: templateId,
                    _business_id: businessId || null,
                    _event_type: eventType,
                    _user_id: userId || null,
                    _metadata_json: metadata ? JSON.stringify(metadata) : null
                },
                type: QueryTypes.INSERT,
                transaction
            }
        );
    }

    async getSystemTemplate(transaction = null) {
        const rows = await sequelize.query(
            `SELECT cht.*, chtv.id_clinical_history_template_version,
                    chtv.version_number, chtv.schema_json, chtv.created_at AS version_created_at
               FROM clinical_history_templates cht
              INNER JOIN clinical_history_template_versions chtv
                      ON ${collateEq('chtv.clinical_history_template_id', 'cht.id_clinical_history_template')}
                     AND chtv.version_number = (
                         SELECT MAX(v.version_number)
                           FROM clinical_history_template_versions v
                          WHERE ${collateEq('v.clinical_history_template_id', 'cht.id_clinical_history_template')}
                     )
              WHERE cht.business_id IS NULL
                AND cht.is_system_template = 1
                AND cht.is_active = 1
                AND cht.deleted_at IS NULL
              ORDER BY cht.created_at ASC
              LIMIT 1`,
            { type: QueryTypes.SELECT, transaction }
        );

        return this.hydrate(rows[0] || null);
    }

    async getBusinessTemplate(businessId, transaction = null) {
        const rows = await sequelize.query(
            `SELECT cht.*, chtv.id_clinical_history_template_version,
                    chtv.version_number, chtv.schema_json, chtv.created_at AS version_created_at
               FROM clinical_history_templates cht
              INNER JOIN clinical_history_template_versions chtv
                      ON ${collateEq('chtv.clinical_history_template_id', 'cht.id_clinical_history_template')}
                     AND chtv.version_number = (
                         SELECT MAX(v.version_number)
                           FROM clinical_history_template_versions v
                          WHERE ${collateEq('v.clinical_history_template_id', 'cht.id_clinical_history_template')}
                     )
              WHERE ${collateEq('cht.business_id', ':_business_id')}
                AND cht.is_system_template = 0
                AND cht.is_active = 1
                AND cht.deleted_at IS NULL
              ORDER BY cht.updated_at DESC, cht.created_at DESC
              LIMIT 1`,
            {
                replacements: { _business_id: businessId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return this.hydrate(rows[0] || null);
    }

    async getCurrentTemplateForBusiness(businessId, transaction = null) {
        const businessTemplate = await this.getBusinessTemplate(businessId, transaction);
        if (businessTemplate) {
            return { template: businessTemplate, source: 'BUSINESS' };
        }

        const systemTemplate = await this.getSystemTemplate(transaction);
        if (systemTemplate) {
            return { template: systemTemplate, source: 'SYSTEM' };
        }

        return { template: null, source: null };
    }

    async current(body) {
        try {
            const canView = await this.hasPermission(body.id_login, PERMISSIONS.VIEW);
            if (!canView) {
                return responseData.unauthorized('No tienes permiso para consultar plantillas de historia clínica.');
            }

            const current = await this.getCurrentTemplateForBusiness(body.id_business);
            if (!current.template) {
                return responseData.notSuccess('No existe plantilla activa de historia clínica.');
            }

            await this.addEvent(current.template.id_clinical_history_template, body.id_business, body.id_login, EVENT.TEMPLATE_VIEWED, { source: current.source });
            return responseData.success(current, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async createBusinessTemplate(body) {
        const transaction = await sequelize.transaction();
        try {
            const canManage = await this.hasPermission(body.id_login, PERMISSIONS.MANAGE);
            if (!canManage) {
                await transaction.rollback();
                return responseData.unauthorized('No tienes permiso para configurar plantillas de historia clínica.');
            }

            const existing = await this.getBusinessTemplate(body.id_business, transaction);
            if (existing) {
                await transaction.rollback();
                return responseData.bad_request('Ya existe una plantilla activa para este negocio.');
            }

            const current = await this.getCurrentTemplateForBusiness(body.id_business, transaction);
            const baseTemplate = current.template || {
                name: 'Historia clínica base',
                description: 'Plantilla base genérica de historia clínica.',
                schema_json: baseClinicalHistoryTemplate
            };

            const templateId = uuidv4();
            const versionId = uuidv4();
            const schemaJson = stringifySchema(baseTemplate.schema_json);

            await sequelize.query(
                `UPDATE clinical_history_templates
                    SET is_active = 0,
                        updated_by_user_id = :_updated_by,
                        updated_at = NOW()
                  WHERE ${collateEq('business_id', ':_business_id')}
                    AND is_system_template = 0
                    AND deleted_at IS NULL`,
                {
                    replacements: { _business_id: body.id_business, _updated_by: body.id_login },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await sequelize.query(
                `INSERT INTO clinical_history_templates (
                    id_clinical_history_template, business_id, name, description,
                    is_system_template, is_active, created_by_user_id, updated_by_user_id,
                    created_at, updated_at, deleted_at
                ) VALUES (
                    :_template_id, :_business_id, :_name, :_description,
                    0, 1, :_created_by, NULL, NOW(), NOW(), NULL
                )`,
                {
                    replacements: {
                        _template_id: templateId,
                        _business_id: body.id_business,
                        _name: body.name || 'Historia clínica del consultorio',
                        _description: body.description || 'Plantilla personalizada del consultorio.',
                        _created_by: body.id_login
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            await sequelize.query(
                `INSERT INTO clinical_history_template_versions (
                    id_clinical_history_template_version, clinical_history_template_id,
                    version_number, schema_json, created_by_user_id, created_at
                ) VALUES (
                    :_version_id, :_template_id, 1, :_schema_json, :_created_by, NOW()
                )`,
                {
                    replacements: {
                        _version_id: versionId,
                        _template_id: templateId,
                        _schema_json: schemaJson,
                        _created_by: body.id_login
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            await this.addEvent(templateId, body.id_business, body.id_login, EVENT.TEMPLATE_CREATED, { source_template_id: baseTemplate.id_clinical_history_template || null }, transaction);
            await this.addEvent(templateId, body.id_business, body.id_login, EVENT.TEMPLATE_VERSION_CREATED, { version_number: 1 }, transaction);
            await this.addEvent(templateId, body.id_business, body.id_login, EVENT.TEMPLATE_ACTIVATED, null, transaction);
            await transaction.commit();

            const currentTemplate = await this.getBusinessTemplate(body.id_business);
            return responseData.success({ template: currentTemplate, source: 'BUSINESS' }, Messages.DATA_SAVE_SUCCESSFULLY);
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async getEditableTemplate(templateId, businessId, transaction = null) {
        const rows = await sequelize.query(
            `SELECT *
               FROM clinical_history_templates
              WHERE ${collateEq('id_clinical_history_template', ':_template_id')}
                AND ${collateEq('business_id', ':_business_id')}
                AND is_system_template = 0
                AND deleted_at IS NULL
              LIMIT 1`,
            {
                replacements: { _template_id: templateId, _business_id: businessId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] || null;
    }

    async nextVersion(templateId, transaction = null) {
        const rows = await sequelize.query(
            `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
               FROM clinical_history_template_versions
              WHERE ${collateEq('clinical_history_template_id', ':_template_id')}`,
            {
                replacements: { _template_id: templateId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] ? Number(rows[0].next_version) : 1;
    }

    async createVersion(body) {
        const transaction = await sequelize.transaction();
        try {
            const canManage = await this.hasPermission(body.id_login, PERMISSIONS.MANAGE);
            if (!canManage) {
                await transaction.rollback();
                return responseData.unauthorized('No tienes permiso para configurar plantillas de historia clínica.');
            }

            const template = await this.getEditableTemplate(body.template_id, body.id_business, transaction);
            if (!template) {
                await transaction.rollback();
                return responseData.unauthorized('La plantilla no pertenece al negocio activo o es plantilla del sistema.');
            }

            const validation = this.validateSchema(body.schema_json);
            if (!validation.ok) {
                await transaction.rollback();
                return responseData.bad_request(validation.message);
            }

            const versionNumber = await this.nextVersion(body.template_id, transaction);
            const versionId = uuidv4();
            await sequelize.query(
                `INSERT INTO clinical_history_template_versions (
                    id_clinical_history_template_version, clinical_history_template_id,
                    version_number, schema_json, created_by_user_id, created_at
                ) VALUES (
                    :_version_id, :_template_id, :_version_number,
                    :_schema_json, :_created_by, NOW()
                )`,
                {
                    replacements: {
                        _version_id: versionId,
                        _template_id: body.template_id,
                        _version_number: versionNumber,
                        _schema_json: stringifySchema(validation.schema),
                        _created_by: body.id_login
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            await sequelize.query(
                `UPDATE clinical_history_templates
                    SET name = COALESCE(:_name, name),
                        description = COALESCE(:_description, description),
                        is_active = 1,
                        updated_by_user_id = :_updated_by,
                        updated_at = NOW()
                  WHERE ${collateEq('id_clinical_history_template', ':_template_id')}
                    AND ${collateEq('business_id', ':_business_id')}`,
                {
                    replacements: {
                        _template_id: body.template_id,
                        _business_id: body.id_business,
                        _name: body.name || null,
                        _description: body.description || null,
                        _updated_by: body.id_login
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await this.addEvent(body.template_id, body.id_business, body.id_login, EVENT.TEMPLATE_VERSION_CREATED, { version_number: versionNumber }, transaction);
            await transaction.commit();

            const currentTemplate = await this.getBusinessTemplate(body.id_business);
            return responseData.success({ template: currentTemplate, source: 'BUSINESS' }, Messages.DATA_SAVE_SUCCESSFULLY);
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }
}

module.exports = new ClinicalHistoryTemplateDao();
module.exports.PERMISSIONS = PERMISSIONS;
module.exports.EVENT = EVENT;

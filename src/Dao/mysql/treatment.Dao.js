const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');
const {dateYMD} = require('../../util/date')

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const collateEq = (left, param) => `${left} COLLATE ${TENANT_COLLATION} = ${param} COLLATE ${TENANT_COLLATION}`;

const PLAN_STATUS = {
    ACTIVE: 'active',
    CLOSED: 'closed',
    CANCELLED: 'cancelled'
};

const TREATMENT_STATUS = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    PAUSED: 'paused'
};

const PERMISSIONS = {
    VIEW: 'treatments.view',
    CREATE: 'treatments.create',
    EDIT: 'treatments.edit',
    CANCEL: 'treatments.cancel',
    COMPLETE: 'treatments.complete',
    CLOSE_PLAN: 'treatments.close_plan'
    ,
    CONSENT_VIEW: 'treatments.consent.view',
    CONSENT_SIGN: 'treatments.consent.sign'
};

/**
 * Clase principal
 */
class TreatmentDao{
    async hasPermission(idLogin, permission) {
        if (!idLogin || !permission) {
            return false;
        }

        const result = await sequelize.query(
            `SELECT cp.id_cat_permission
               FROM login l
              INNER JOIN permission_rol pr ON ${collateEq('pr.id_rol', 'l.id_rol')} AND pr.active = 1
              INNER JOIN cat_permission cp ON ${collateEq('cp.id_cat_permission', 'pr.id_cat_permission')}
              WHERE ${collateEq('l.id_login', ':_id_login')}
                AND ${collateEq('cp.code', ':_permission')}
                AND cp.active = 1
                AND cp.is_active = 1
              LIMIT 1`,
            {
                replacements: {
                    _id_login: idLogin,
                    _permission: permission
                },
                type: QueryTypes.SELECT
            }
        );

        return result.length > 0;
    }

    async getPatient(idPerson, idBusiness) {
        const result = await sequelize.query(
            `SELECT id_person, id_business, name, surname, age, birthday
               FROM person
              WHERE ${collateEq('id_person', ':_id_person')}
                AND ${collateEq('id_business', ':_id_business')}
                AND active = 1
              LIMIT 1`,
            {
                replacements: {
                    _id_person: idPerson,
                    _id_business: idBusiness
                },
                type: QueryTypes.SELECT
            }
        );

        return result[0] || null;
    }

    async getClinicalModules(idBusiness) {
        const result = await sequelize.query(
            `SELECT odontogram_enabled AS odontogramEnabled,
                    treatment_plan_enabled AS treatmentPlanEnabled,
                    allow_treatment_tooth_selection AS allowTreatmentToothSelection,
                    show_treatment_costs AS showTreatmentCosts,
                    show_treatment_status AS showTreatmentStatus
               FROM clinical_module_config
              WHERE ${collateEq('id_business', ':_id_business')}
              LIMIT 1`,
            {
                replacements: { _id_business: idBusiness },
                type: QueryTypes.SELECT
            }
        );

        const config = result[0] || {};
        return {
            odontogramEnabled: Boolean(config.odontogramEnabled),
            treatmentPlanEnabled: config.treatmentPlanEnabled === undefined ? true : Boolean(config.treatmentPlanEnabled),
            allowTreatmentToothSelection: Boolean(config.allowTreatmentToothSelection),
            showTreatmentCosts: config.showTreatmentCosts === undefined ? true : Boolean(config.showTreatmentCosts),
            showTreatmentStatus: config.showTreatmentStatus === undefined ? true : Boolean(config.showTreatmentStatus)
        };
    }

    async ensureActivePlan(idPerson, idBusiness, idLogin) {
        const current = await sequelize.query(
            `SELECT id_treatment_plan
               FROM treatment_plan
              WHERE ${collateEq('id_business', ':_id_business')}
                AND ${collateEq('id_person', ':_id_person')}
                AND status = 'active'
                AND active = 1
              ORDER BY created_at DESC
              LIMIT 1`,
            {
                replacements: {
                    _id_person: idPerson,
                    _id_business: idBusiness
                },
                type: QueryTypes.SELECT
            }
        );

        if (current[0]) {
            return current[0].id_treatment_plan;
        }

        const idPlan = uuidv4();
        await sequelize.query(
            `INSERT INTO treatment_plan (
                id_treatment_plan, id_business, id_person, title, status, started_at,
                active, created_at, created_by
            ) VALUES (
                :_id_treatment_plan, :_id_business, :_id_person, 'Plan de tratamiento',
                'active', CURDATE(), 1, NOW(), :_id_login
            )`,
            {
                replacements: {
                    _id_treatment_plan: idPlan,
                    _id_business: idBusiness,
                    _id_person: idPerson,
                    _id_login: idLogin
                },
                type: QueryTypes.INSERT
            }
        );

        return idPlan;
    }

    async getPlan(body) {
        try {
            if (!body.id_business) {
                return responseData.unauthorized('No hay negocio activo para consultar tratamientos.');
            }

            const canView = await this.hasPermission(body.id_login, PERMISSIONS.VIEW);
            if (!canView) {
                return responseData.unauthorized('No tienes permiso para consultar tratamientos.');
            }

            const patient = await this.getPatient(body.id_person, body.id_business);
            if (!patient) {
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }
            const config = await this.getClinicalModules(body.id_business);

            const plans = await sequelize.query(
                `SELECT id_treatment_plan, id_business, id_person, title, diagnosis, notes, status,
                        started_at, closed_at, close_reason, created_at, created_by, updated_at, updated_by
                   FROM treatment_plan
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_person', ':_id_person')}
                    AND active = 1
                  ORDER BY FIELD(status, 'active', 'closed', 'cancelled'), created_at DESC`,
                {
                    replacements: {
                        _id_business: body.id_business,
                        _id_person: body.id_person
                    },
                    type: QueryTypes.SELECT
                }
            );

            const treatments = await sequelize.query(
                `SELECT pt.id_patient_treatment, pt.id_treatment_plan, pt.id_business, pt.id_person,
                        pt.name, pt.description, pt.category, pt.status, pt.priority,
                        pt.estimated_start_date, pt.estimated_end_date, pt.cost, pt.notes,
                        pt.source, pt.created_at, pt.created_by, pt.updated_at, pt.updated_by,
                        GROUP_CONCAT(ptt.tooth_number ORDER BY CAST(ptt.tooth_number AS UNSIGNED) SEPARATOR ',') AS teeth
                   FROM patient_treatment pt
                   LEFT JOIN patient_treatment_tooth ptt
                          ON ptt.id_patient_treatment = pt.id_patient_treatment
                  WHERE ${collateEq('pt.id_business', ':_id_business')}
                    AND ${collateEq('pt.id_person', ':_id_person')}
                    AND pt.active = 1
                  GROUP BY pt.id_patient_treatment, pt.id_treatment_plan, pt.id_business, pt.id_person,
                           pt.name, pt.description, pt.category, pt.status, pt.priority,
                           pt.estimated_start_date, pt.estimated_end_date, pt.cost, pt.notes,
                           pt.source, pt.created_at, pt.created_by, pt.updated_at, pt.updated_by
                  ORDER BY FIELD(pt.status, 'pending', 'in_progress', 'paused', 'completed', 'cancelled'), pt.created_at DESC`,
                {
                    replacements: {
                        _id_business: body.id_business,
                        _id_person: body.id_person
                    },
                    type: QueryTypes.SELECT
                }
            );

            const byPlan = treatments.reduce((acc, treatment) => {
                const item = {
                    ...treatment,
                    teeth: treatment.teeth ? treatment.teeth.split(',') : []
                };
                acc[item.id_treatment_plan] = acc[item.id_treatment_plan] || [];
                acc[item.id_treatment_plan].push(item);
                return acc;
            }, {});

            const consents = await sequelize.query(
                `SELECT id_treatment_plan_consent, id_business, id_person, id_treatment_plan,
                        declare_text_snapshot, consent_text_snapshot, patient_signature,
                        doctor_signature_snapshot, doctor_name_snapshot, professional_license_snapshot, signed_at,
                        signed_by_user_id, created_at, created_by, updated_at, updated_by
                   FROM treatment_plan_consent
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_person', ':_id_person')}
                    AND active = 1`,
                {
                    replacements: {
                        _id_business: body.id_business,
                        _id_person: body.id_person
                    },
                    type: QueryTypes.SELECT
                }
            );

            const consentByPlan = consents.reduce((acc, consent) => {
                acc[consent.id_treatment_plan] = consent;
                return acc;
            }, {});

            const enrichedPlans = plans.map((plan) => ({
                ...plan,
                treatments: byPlan[plan.id_treatment_plan] || [],
                consent: consentByPlan[plan.id_treatment_plan] || null
            }));

            return responseData.success({
                patient,
                config,
                activePlan: enrichedPlans.find((plan) => plan.status === PLAN_STATUS.ACTIVE) || null,
                history: enrichedPlans.filter((plan) => plan.status !== PLAN_STATUS.ACTIVE)
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async createPlan(body) {
        try {
            if (!body.id_business) {
                return responseData.unauthorized('No hay negocio activo para crear plan.');
            }

            const canCreate = await this.hasPermission(body.id_login, PERMISSIONS.CREATE);
            if (!canCreate) {
                return responseData.unauthorized('No tienes permiso para crear planes de tratamiento.');
            }

            const patient = await this.getPatient(body.id_person, body.id_business);
            if (!patient) {
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const existing = await sequelize.query(
                `SELECT id_treatment_plan
                   FROM treatment_plan
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_person', ':_id_person')}
                    AND status = 'active'
                    AND active = 1
                  LIMIT 1`,
                {
                    replacements: {
                        _id_business: body.id_business,
                        _id_person: body.id_person
                    },
                    type: QueryTypes.SELECT
                }
            );

            if (existing[0]) {
                return responseData.bad_request('Ya existe un plan activo. Cierra el plan actual antes de crear uno nuevo.');
            }

            const idPlan = uuidv4();
            await sequelize.query(
                `INSERT INTO treatment_plan (
                    id_treatment_plan, id_business, id_person, title, diagnosis, notes, status,
                    started_at, active, created_at, created_by
                ) VALUES (
                    :_id_treatment_plan, :_id_business, :_id_person, :_title, :_diagnosis, :_notes,
                    'active', :_started_at, 1, NOW(), :_id_login
                )`,
                {
                    replacements: {
                        _id_treatment_plan: idPlan,
                        _id_business: body.id_business,
                        _id_person: body.id_person,
                        _title: body.title || 'Plan de tratamiento',
                        _diagnosis: body.diagnosis || null,
                        _notes: body.notes || null,
                        _started_at: body.started_at || new Date().toISOString().slice(0, 10),
                        _id_login: body.id_login
                    },
                    type: QueryTypes.INSERT
                }
            );

            return this.getPlan(body);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async closePlan(body) {
        try {
            if (!body.id_business) {
                return responseData.unauthorized('No hay negocio activo para cerrar plan.');
            }

            const canClose = await this.hasPermission(body.id_login, PERMISSIONS.CLOSE_PLAN);
            if (!canClose) {
                return responseData.unauthorized('No tienes permiso para cerrar planes de tratamiento.');
            }

            const patient = await this.getPatient(body.id_person, body.id_business);
            if (!patient) {
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            await sequelize.query(
                `UPDATE treatment_plan
                    SET status = 'closed',
                        closed_at = NOW(),
                        closed_by = :_id_login,
                        close_reason = :_close_reason,
                        updated_at = NOW(),
                        updated_by = :_id_login
                  WHERE ${collateEq('id_treatment_plan', ':_id_treatment_plan')}
                    AND ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_person', ':_id_person')}
                    AND status = 'active'`,
                {
                    replacements: {
                        _id_treatment_plan: body.id_treatment_plan,
                        _id_business: body.id_business,
                        _id_person: body.id_person,
                        _close_reason: body.close_reason || null,
                        _id_login: body.id_login
                    },
                    type: QueryTypes.UPDATE
                }
            );

            return this.getPlan(body);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async savePlanTreatment(body) {
        try {
            if (!body.id_business) {
                return responseData.unauthorized('No hay negocio activo para guardar tratamiento.');
            }

            const isUpdate = Boolean(body.id_patient_treatment);
            const canSave = await this.hasPermission(body.id_login, isUpdate ? PERMISSIONS.EDIT : PERMISSIONS.CREATE);
            if (!canSave) {
                return responseData.unauthorized('No tienes permiso para guardar tratamientos.');
            }

            const patient = await this.getPatient(body.id_person, body.id_business);
            if (!patient) {
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const idPlan = body.id_treatment_plan || await this.ensureActivePlan(body.id_person, body.id_business, body.id_login);
            const plan = await sequelize.query(
                `SELECT id_treatment_plan
                   FROM treatment_plan
                  WHERE ${collateEq('id_treatment_plan', ':_id_treatment_plan')}
                    AND ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_person', ':_id_person')}
                    AND status = 'active'
                    AND active = 1
                  LIMIT 1`,
                {
                    replacements: {
                        _id_treatment_plan: idPlan,
                        _id_business: body.id_business,
                        _id_person: body.id_person
                    },
                    type: QueryTypes.SELECT
                }
            );

            if (!plan[0]) {
                return responseData.bad_request('Solo se pueden modificar tratamientos del plan activo.');
            }

            const idTreatment = body.id_patient_treatment || uuidv4();
            const status = isUpdate && Object.values(TREATMENT_STATUS).includes(body.status) ? body.status : TREATMENT_STATUS.PENDING;
            const replacements = {
                _id_patient_treatment: idTreatment,
                _id_business: body.id_business,
                _id_person: body.id_person,
                _id_treatment_plan: idPlan,
                _name: body.name,
                _description: body.description || null,
                _category: body.category || null,
                _status: status,
                _priority: body.priority || null,
                _estimated_start_date: body.estimated_start_date || null,
                _estimated_end_date: body.estimated_end_date || null,
                _cost: body.cost === '' || body.cost === undefined ? null : body.cost,
                _notes: body.notes || null,
                _id_login: body.id_login
            };

            if (isUpdate) {
                await sequelize.query(
                    `UPDATE patient_treatment
                        SET name = :_name,
                            description = :_description,
                            category = :_category,
                            status = :_status,
                            priority = :_priority,
                            estimated_start_date = :_estimated_start_date,
                            estimated_end_date = :_estimated_end_date,
                            cost = :_cost,
                            notes = :_notes,
                            updated_at = NOW(),
                            updated_by = :_id_login
                      WHERE ${collateEq('id_patient_treatment', ':_id_patient_treatment')}
                        AND ${collateEq('id_business', ':_id_business')}
                        AND ${collateEq('id_person', ':_id_person')}
                        AND ${collateEq('id_treatment_plan', ':_id_treatment_plan')}`,
                    { replacements, type: QueryTypes.UPDATE }
                );
            } else {
                await sequelize.query(
                    `INSERT INTO patient_treatment (
                        id_patient_treatment, id_business, id_person, id_treatment_plan, name, description,
                        category, status, priority, estimated_start_date, estimated_end_date, cost, notes,
                        source, active, created_at, created_by
                    ) VALUES (
                        :_id_patient_treatment, :_id_business, :_id_person, :_id_treatment_plan, :_name, :_description,
                        :_category, :_status, :_priority, :_estimated_start_date, :_estimated_end_date, :_cost, :_notes,
                        'manual', 1, NOW(), :_id_login
                    )`,
                    { replacements, type: QueryTypes.INSERT }
                );
            }

            await sequelize.query(
                `DELETE FROM patient_treatment_tooth
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_patient_treatment', ':_id_patient_treatment')}`,
                {
                    replacements: {
                        _id_business: body.id_business,
                        _id_patient_treatment: idTreatment
                    },
                    type: QueryTypes.DELETE
                }
            );

            const teeth = Array.isArray(body.teeth) ? body.teeth.filter(Boolean) : [];
            for (const tooth of teeth) {
                await sequelize.query(
                    `INSERT INTO patient_treatment_tooth (
                        id_patient_treatment_tooth, id_business, id_patient_treatment, tooth_number, created_at
                    ) VALUES (
                        :_id_patient_treatment_tooth, :_id_business, :_id_patient_treatment, :_tooth_number, NOW()
                    )`,
                    {
                        replacements: {
                            _id_patient_treatment_tooth: uuidv4(),
                            _id_business: body.id_business,
                            _id_patient_treatment: idTreatment,
                            _tooth_number: String(tooth)
                        },
                        type: QueryTypes.INSERT
                    }
                );
            }

            return this.getPlan(body);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async updatePlanTreatmentStatus(body) {
        try {
            const permission = body.status === TREATMENT_STATUS.COMPLETED ? PERMISSIONS.COMPLETE : PERMISSIONS.CANCEL;
            const canUpdate = await this.hasPermission(body.id_login, permission) || await this.hasPermission(body.id_login, PERMISSIONS.EDIT);
            if (!canUpdate) {
                return responseData.unauthorized('No tienes permiso para cambiar el estado del tratamiento.');
            }

            await sequelize.query(
                `UPDATE patient_treatment pt
                  INNER JOIN treatment_plan tp ON tp.id_treatment_plan = pt.id_treatment_plan
                    SET pt.status = :_status,
                        pt.updated_at = NOW(),
                        pt.updated_by = :_id_login
                  WHERE ${collateEq('pt.id_patient_treatment', ':_id_patient_treatment')}
                    AND ${collateEq('pt.id_business', ':_id_business')}
                    AND ${collateEq('pt.id_person', ':_id_person')}
                    AND tp.status = 'active'`,
                {
                    replacements: {
                        _id_patient_treatment: body.id_patient_treatment,
                        _id_business: body.id_business,
                        _id_person: body.id_person,
                        _status: Object.values(TREATMENT_STATUS).includes(body.status) ? body.status : TREATMENT_STATUS.PENDING,
                        _id_login: body.id_login
                    },
                    type: QueryTypes.UPDATE
                }
            );

            return this.getPlan(body);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async deletePlanTreatment(body) {
        try {
            const canDelete = await this.hasPermission(body.id_login, PERMISSIONS.EDIT);
            if (!canDelete) {
                return responseData.unauthorized('No tienes permiso para eliminar tratamientos.');
            }

            await sequelize.query(
                `UPDATE patient_treatment pt
                  INNER JOIN treatment_plan tp ON tp.id_treatment_plan = pt.id_treatment_plan
                    SET pt.active = 0,
                        pt.updated_at = NOW(),
                        pt.updated_by = :_id_login
                  WHERE ${collateEq('pt.id_patient_treatment', ':_id_patient_treatment')}
                    AND ${collateEq('pt.id_business', ':_id_business')}
                    AND ${collateEq('pt.id_person', ':_id_person')}
                    AND tp.status = 'active'`,
                {
                    replacements: {
                        _id_patient_treatment: body.id_patient_treatment,
                        _id_business: body.id_business,
                        _id_person: body.id_person,
                        _id_login: body.id_login
                    },
                    type: QueryTypes.UPDATE
                }
            );

            return this.getPlan(body);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async savePlanConsent(body) {
        try {
            if (!body.id_business) {
                return responseData.unauthorized('No hay negocio activo para guardar consentimiento.');
            }

            const canSign = await this.hasPermission(body.id_login, PERMISSIONS.CONSENT_SIGN);
            if (!canSign) {
                return responseData.unauthorized('No tienes permiso para firmar consentimiento del plan.');
            }

            const patient = await this.getPatient(body.id_person, body.id_business);
            if (!patient) {
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const plan = await sequelize.query(
                `SELECT id_treatment_plan
                   FROM treatment_plan
                  WHERE ${collateEq('id_treatment_plan', ':_id_treatment_plan')}
                    AND ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_person', ':_id_person')}
                    AND status = 'active'
                    AND active = 1
                  LIMIT 1`,
                {
                    replacements: {
                        _id_treatment_plan: body.id_treatment_plan,
                        _id_business: body.id_business,
                        _id_person: body.id_person
                    },
                    type: QueryTypes.SELECT
                }
            );

            if (!plan[0]) {
                return responseData.bad_request('Solo se puede firmar el consentimiento del plan activo.');
            }

            const existing = await sequelize.query(
                `SELECT id_treatment_plan_consent
                   FROM treatment_plan_consent
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_treatment_plan', ':_id_treatment_plan')}
                    AND active = 1
                  LIMIT 1`,
                {
                    replacements: {
                        _id_business: body.id_business,
                        _id_treatment_plan: body.id_treatment_plan
                    },
                    type: QueryTypes.SELECT
                }
            );

            const replacements = {
                _id_treatment_plan_consent: existing[0] ? existing[0].id_treatment_plan_consent : uuidv4(),
                _id_business: body.id_business,
                _id_person: body.id_person,
                _id_treatment_plan: body.id_treatment_plan,
                _declare_text_snapshot: body.declare_text_snapshot || null,
                _consent_text_snapshot: body.consent_text_snapshot || null,
                _patient_signature: body.patient_signature,
                _doctor_signature_snapshot: body.doctor_signature_snapshot || null,
                _doctor_name_snapshot: body.doctor_name_snapshot || null,
                _professional_license_snapshot: body.professional_license_snapshot || null,
                _id_login: body.id_login
            };

            if (existing[0]) {
                await sequelize.query(
                    `UPDATE treatment_plan_consent
                        SET declare_text_snapshot = :_declare_text_snapshot,
                            consent_text_snapshot = :_consent_text_snapshot,
                            patient_signature = :_patient_signature,
                            doctor_signature_snapshot = :_doctor_signature_snapshot,
                            doctor_name_snapshot = :_doctor_name_snapshot,
                            professional_license_snapshot = :_professional_license_snapshot,
                            signed_at = NOW(),
                            signed_by_user_id = :_id_login,
                            updated_at = NOW(),
                            updated_by = :_id_login
                      WHERE ${collateEq('id_treatment_plan_consent', ':_id_treatment_plan_consent')}
                        AND ${collateEq('id_business', ':_id_business')}
                        AND ${collateEq('id_treatment_plan', ':_id_treatment_plan')}`,
                    { replacements, type: QueryTypes.UPDATE }
                );
            } else {
                await sequelize.query(
                    `INSERT INTO treatment_plan_consent (
                        id_treatment_plan_consent, id_business, id_person, id_treatment_plan,
                        declare_text_snapshot, consent_text_snapshot, patient_signature,
                        doctor_signature_snapshot, doctor_name_snapshot, professional_license_snapshot, signed_at, signed_by_user_id,
                        active, created_at, created_by
                    ) VALUES (
                        :_id_treatment_plan_consent, :_id_business, :_id_person, :_id_treatment_plan,
                        :_declare_text_snapshot, :_consent_text_snapshot, :_patient_signature,
                        :_doctor_signature_snapshot, :_doctor_name_snapshot, :_professional_license_snapshot, NOW(), :_id_login,
                        1, NOW(), :_id_login
                    )`,
                    { replacements, type: QueryTypes.INSERT }
                );
            }

            return this.getPlan(body);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    /**
     * Permite Registrar un nuevo seguimiento
     * @param {any} body PayLoad 
     * @returns
     */
    async saveTreatment(body) {
        let response;        
        try {

            let _treatment =  body.treatment ? JSON.stringify((body.treatment)) : null;

            let result = await sequelize.query(SequelizeSP.SP_TREATMENT_SAVE, {
                replacements: {
                    _treatment : _treatment,
                    _id_person : body.id_person,
                    _id_login : body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite actualizar un nuevo seguimiento
     * @param {any} body PayLoad 
     * @returns
     */
    async UpdateTreatment(body) {
        let response;        
        try {

            let _treatment =  body.treatment ? JSON.stringify((body.treatment)) : null;

            let result = await sequelize.query(SequelizeSP.SP_TREATMENT_UPDATE, {
                replacements: {
                    _treatment : _treatment,
                    _id_person : body.id_person,
                    _id_login : body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.error(Messages.DATA_SAVE_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite eliminar un registro seguimiento
     * @param {any} body PayLoad 
     * @returns
     */
    async DeleteTreatment(body) {
        let response;        
        try {

            let result = await sequelize.query(SequelizeSP.SP_TREATMENT_DELETE, {
                replacements: {
                    _id_treatment : body.id_treatment,
                    _id_person : body.id_person
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite listar el seguimiento de un paciente
     * @param {String} id_person id del PX 
     * @returns
     */
    async getTreatment(id_person) {
        let response;        
        try {

            let result = await sequelize.query(SequelizeSP.SP_TREATMENT_GET, {
                replacements: {
                    _id_person : id_person
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite listar el seguimiento de un paciente
     * @param {String} id_person id del PX 
     * @returns
     */
    async catTreatment(body) {
        let response;        
        try {
            if (body && body.id_business) {
                const result = await sequelize.query(
                    `SELECT pt.id_patient_treatment AS id,
                            pt.name,
                            pt.status,
                            pt.id_treatment_plan,
                            GROUP_CONCAT(ptt.tooth_number ORDER BY CAST(ptt.tooth_number AS UNSIGNED) SEPARATOR ',') AS teeth
                       FROM patient_treatment pt
                      INNER JOIN treatment_plan tp
                         ON tp.id_treatment_plan = pt.id_treatment_plan
                        AND tp.status = 'active'
                        AND tp.active = 1
                       LEFT JOIN patient_treatment_tooth ptt
                         ON ptt.id_patient_treatment = pt.id_patient_treatment
                      WHERE ${collateEq('pt.id_business', ':_id_business')}
                        AND ${collateEq('pt.id_person', ':_id_person')}
                        AND pt.active = 1
                      GROUP BY pt.id_patient_treatment, pt.name, pt.status, pt.id_treatment_plan
                      ORDER BY pt.name ASC`,
                    {
                        replacements: {
                            _id_business: body.id_business,
                            _id_person: body.id_person
                        },
                        type: QueryTypes.SELECT
                    }
                );

                return responseData.success(result.map((item) => ({
                    ...item,
                    teeth: item.teeth ? item.teeth.split(',') : []
                })), Messages.DATA_GET_SUCCESSFULLY);
            }

            let result = await sequelize.query(SequelizeSP.SP_CAT_TREATMENT_GET, {
                replacements: {
                    _id_person : body
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }



    /**
     * Permite listar el seguimiento de un paciente
     * @param {String} id_person id del PX 
     * @returns
     */
    async getDiagnosis(id_person) {
        let response;        
        try {

            let result = await sequelize.query(SequelizeSP.SP_DIAGNOSIS_GET, {
                replacements: {
                    _id_person : id_person
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);

                if( !SQLValid.hasError ){

                    let newresult = result.map((p)=>{
                        return{
                            sec : p.sec,
                            id_diagnosis : p.id_diagnosis,
                            id_odontogram : p.id_odontogram,
                            id_person : p.id_person,
                            symbol : p.symbol,
                            observation : p.observation,
                            json : JSON.parse(p.json.toString()),
                            treatment : p.treatment,
                            amount: Number(p.amount)
                        }
                    });

                    response = responseData.success(newresult, Messages.DATA_GET_SUCCESSFULLY);
                }
                else{
                    response =  responseData.notSuccess(Messages.DATA_GET_ERROR);
                }
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

        /**
     * Permite listar el seguimiento de un paciente
     * @param {String} id_person id del PX 
     * @returns
     */
        async saveDiagnosis(body) {
            let response;        
            try {
    
                let result = await sequelize.query(SequelizeSP.SP_DIAGNOSIS_UPDATE, {
                    replacements: {
                        _id_diagnosis : body.id_diagnosis,
                        _id_odontogram : body.id_odontogram,
                        _id_person : body.id_person,
                        _treatment : body.treatment,
                        _amount : body.amount,
                        _id_login : body.id_login
                    },
                    type: QueryTypes.RAW,
                    plain: true
                });
    
                if(result){/*Validamos si existe un registro de salida */
                    let SQLValid = SQLException(result);
    
                    response =  !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
                }
                else{/* regresamos una excepción controlada al no obtener una respuesta */
                    response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
                }
            } catch (error) {
                    response = SequelizeException(error, Messages.DATA_GET_ERROR);
            }
            return response;
        }

}

module.exports = new TreatmentDao;

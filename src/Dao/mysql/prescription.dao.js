const { snapshotPatient, withPatientIdentity } = require('../../domain/prescriptions/patientIdentity');
const effectivePermissions = require('../../util/effectivePermissions');
const { listPage, pageWindow, pageData } = require('../../util/listPage');
const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const { resolveProfessional } = require('../../util/professionalContext');

const STATUS = {
    DRAFT: 'draft',
    ISSUED: 'issued',
    CANCELLED: 'cancelled'
};

const PERMISSIONS = {
    VIEW_OWN: 'prescriptions.view.own',
    VIEW_ALL: 'prescriptions.view.all',
    CREATE: 'prescriptions.create',
    EDIT_DRAFT: 'prescriptions.edit_draft',
    ISSUE: 'prescriptions.issue',
    CANCEL: 'prescriptions.cancel',
    PRINT: 'prescriptions.print',
    DOWNLOAD: 'prescriptions.download',
    CONFIG: 'prescriptions.config'
};

const PROFESSIONAL_PROFILE_MESSAGE = 'Para emitir recetas, el doctor debe completar su identidad, cédula y firma en Configuración > Mi perfil profesional. Después, actualiza los doctores de la receta; puedes conservarla como borrador.';
const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const collateEq = (left, param) => `${left} COLLATE ${TENANT_COLLATION} = ${param} COLLATE ${TENANT_COLLATION}`;

class PrescriptionDao {
    async getConfig(id_business, doctorProfileId = null, idLogin = null) {
        try {
            if (!id_business) {
                return responseData.unauthorized('No hay negocio activo para consultar configuracion de recetas.');
            }

            const resolved = await resolveProfessional({ id_business, id_login: idLogin }, doctorProfileId);
            if (resolved.error) return doctorProfileId ? resolved.error : responseData.success(null, 'Selecciona un doctor para consultar su configuracion.');
            const doctor = resolved.doctor;
            if (!(await this.hasPermission(idLogin, PERMISSIONS.CONFIG))) return responseData.forbidden('No tienes permiso para configurar recetas.');
            if (doctor.id_login !== idLogin && !(await effectivePermissions.isTenantAdministrator(idLogin, id_business, 'admin.config'))) return responseData.forbidden('Solo puedes configurar tus propias recetas.');
            const result = await sequelize.query(
                `SELECT *
                   FROM prescription_config
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND doctor_profile_id = :_doctor_profile_id
                    AND active = 1
                  LIMIT 1`,
                {
                    replacements: { _id_business: id_business, _doctor_profile_id: doctor.id_doctor_professional_profile },
                    type: QueryTypes.SELECT
                }
            );

            let initial = result[0];
            if (!initial) {
                const shared = await sequelize.query(`SELECT * FROM prescription_config WHERE ${collateEq('id_business', ':_id_business')} AND doctor_profile_id IS NULL AND active = 1 LIMIT 1`, {
                    replacements: { _id_business: id_business }, type: QueryTypes.SELECT
                });
                initial = shared[0] || {};
            }
            return responseData.success({ ...initial, id_prescription_config: result[0] ? result[0].id_prescription_config : null, doctor_profile_id: doctor.id_doctor_professional_profile,
                doctor_profile: doctor }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async saveConfig(body) {
        try {
            if (!body.id_business) {
                return responseData.unauthorized('No hay negocio activo para guardar configuracion de recetas.');
            }

            const canConfig = await this.hasPermission(body.id_login, PERMISSIONS.CONFIG);
            if (!canConfig) {
                return responseData.unauthorized('No tienes permiso para configurar recetas.');
            }

            const resolved = await resolveProfessional(body, body.doctor_profile_id);
            if (resolved.error) return resolved.error;
            const doctor = resolved.doctor;
            if (doctor.id_login !== body.id_login && !(await effectivePermissions.isTenantAdministrator(body.id_login, body.id_business, 'admin.config'))) {
                return responseData.forbidden('Solo puedes configurar tus propias recetas.');
            }

            const idConfig = body.id_prescription_config || uuidv4();
            const current = await sequelize.query(
                `SELECT id_prescription_config
                   FROM prescription_config
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND doctor_profile_id = :_doctor_profile_id
                    AND active = 1
                  LIMIT 1`,
                {
                    replacements: { _id_business: body.id_business, _doctor_profile_id: doctor.id_doctor_professional_profile },
                    type: QueryTypes.SELECT
                }
            );

            const replacements = {
                _id_prescription_config: current[0] ? current[0].id_prescription_config : idConfig,
                _id_business: body.id_business,
                _doctor_profile_id: doctor.id_doctor_professional_profile,
                _doctor_name: body.doctor_name || null,
                _professional_license: body.professional_license || null,
                _university: body.university || null,
                _specialty: body.specialty || null,
                _specialty_license: body.specialty_license || null,
                _clinic_name: body.clinic_name || null,
                _clinic_address: body.clinic_address || null,
                _clinic_phone: body.clinic_phone || null,
                _signature_image: body.signature_image || null,
                _header_image: body.header_image || null,
                _background_image: body.background_image || null,
                _footer_note: body.footer_note || null,
                _template_mode: body.template_mode || 'header',
                _background_opacity: body.background_opacity === undefined ? 0.10 : body.background_opacity,
                _show_specialty: body.show_specialty === false ? 0 : 1,
                _show_university: body.show_university === false ? 0 : 1,
                _show_footer_note: body.show_footer_note === false ? 0 : 1,
                _id_login: body.id_login || null
            };

            if (current[0]) {
                await sequelize.query(
                    `UPDATE prescription_config
                        SET doctor_name = :_doctor_name,
                            professional_license = :_professional_license,
                            university = :_university,
                            specialty = :_specialty,
                            specialty_license = :_specialty_license,
                            clinic_name = :_clinic_name,
                            clinic_address = :_clinic_address,
                            clinic_phone = :_clinic_phone,
                            signature_image = :_signature_image,
                            header_image = :_header_image,
                            background_image = :_background_image,
                            footer_note = :_footer_note,
                            template_mode = :_template_mode,
                            background_opacity = :_background_opacity,
                            show_specialty = :_show_specialty,
                            show_university = :_show_university,
                            show_footer_note = :_show_footer_note,
                            updated_at = NOW(),
                            updated_by = :_id_login
                      WHERE ${collateEq('id_prescription_config', ':_id_prescription_config')}
                        AND ${collateEq('id_business', ':_id_business')}`,
                    { replacements, type: QueryTypes.UPDATE }
                );
            } else {
                await sequelize.query(
                    `INSERT INTO prescription_config (
                        id_prescription_config, id_business, doctor_profile_id, doctor_name, professional_license, university,
                        specialty, specialty_license, clinic_name, clinic_address, clinic_phone,
                        signature_image, header_image, background_image, footer_note, template_mode,
                        background_opacity, show_specialty, show_university, show_footer_note,
                        active, created_at, created_by
                    ) VALUES (
                        :_id_prescription_config, :_id_business, :_doctor_profile_id, :_doctor_name, :_professional_license, :_university,
                        :_specialty, :_specialty_license, :_clinic_name, :_clinic_address, :_clinic_phone,
                        :_signature_image, :_header_image, :_background_image, :_footer_note, :_template_mode,
                        :_background_opacity, :_show_specialty, :_show_university, :_show_footer_note,
                        1, NOW(), :_id_login
                    )`,
                    { replacements, type: QueryTypes.INSERT }
                );
            }

            return this.getConfig(body.id_business, doctor.id_doctor_professional_profile, body.id_login);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async list(body) {
        try {
            const paging = listPage(body);
            if (!body.id_business) {
                return responseData.unauthorized('No hay negocio activo para consultar recetas.');
            }

            const access = await this.getViewAccess(body.id_login);
            if (!access.canViewOwn && !access.canViewAll) {
                return responseData.unauthorized('No tienes permiso para consultar recetas.');
            }

            const where = [
                collateEq('p.id_business', ':_id_business'),
                'p.active = 1'
            ];
            const replacements = {
                _id_business: body.id_business,
                _id_login: body.id_login,
                _date_from: body.date_from || null,
                _date_to: body.date_to || null,
                _id_person: body.id_person || null,
                _issuer_doctor_id: body.issuer_doctor_id || null,
                _status: body.status || null,
                _search: body.search ? `%${body.search}%` : null
            };

            if (body.id_person) {
                const patient = await this.getPatient(body.id_person, body.id_business);
                if (!patient) {
                    return responseData.unauthorized('El paciente no pertenece al negocio activo.');
                }
                where.push(collateEq('p.id_person', ':_id_person'));
            }

            if (!access.canViewAll) {
                where.push(`(${collateEq('p.issuer_doctor_id', ':_id_login')} OR ${collateEq('p.created_by', ':_id_login')})`);
            }

            if (body.date_from) {
                where.push('p.issue_date >= :_date_from');
            }

            if (body.date_to) {
                where.push('p.issue_date <= :_date_to');
            }

            if (body.issuer_doctor_id) {
                where.push(collateEq('p.issuer_doctor_id', ':_issuer_doctor_id'));
            }

            if (body.status) {
                where.push(collateEq('p.status', ':_status'));
            }

            if (body.search) {
                where.push(`(
                    p.folio COLLATE ${TENANT_COLLATION} LIKE :_search COLLATE ${TENANT_COLLATION}
                    OR person.name COLLATE ${TENANT_COLLATION} LIKE :_search COLLATE ${TENANT_COLLATION}
                    OR person.surname COLLATE ${TENANT_COLLATION} LIKE :_search COLLATE ${TENANT_COLLATION}
                    OR doctor.name COLLATE ${TENANT_COLLATION} LIKE :_search COLLATE ${TENANT_COLLATION}
                )`);
            }

            let pagination;
            if (paging) {
                const counts = await sequelize.query(`SELECT COUNT(*) AS total FROM prescription p
                    INNER JOIN person ON ${collateEq('person.id_person', 'p.id_person')} AND ${collateEq('person.id_business', 'p.id_business')}
                    LEFT JOIN login doctor ON ${collateEq('doctor.id_login', 'p.issuer_doctor_id')}
                    WHERE ${where.join(' AND ')}`, { replacements, type: QueryTypes.SELECT });
                pagination = pageWindow(paging, counts[0].total);
                replacements._limit = pagination.pageSize;
                replacements._offset = pagination.offset;
            }
            const result = pagination && !pagination.total ? [] : await sequelize.query(
                `SELECT
                    p.id_prescription,
                    p.folio,
                    p.status,
                    p.issue_date,
                    p.issued_at,
                    p.cancelled_at,
                    p.id_person,
                    p.template_snapshot,
                    TRIM(CONCAT(IFNULL(person.name, ''), ' ', IFNULL(person.surname, ''))) AS patient_name,
                    person.birthday AS patient_birthday,
                    person.age AS patient_age,
                    p.issuer_doctor_id,
                    COALESCE(p.doctor_name_snapshot, dpp.professional_name, doctor.name) AS doctor_name,
                    p.created_by,
                    creator.name AS created_by_name,
                    p.issued_by,
                    issuer.name AS issued_by_name,
                    p.cancelled_by,
                    canceller.name AS cancelled_by_name,
                    p.diagnosis,
                    p.notes,
                    p.cancellation_reason,
                    (
                        SELECT GROUP_CONCAT(pi.generic_name ORDER BY pi.sort_order SEPARATOR ', ')
                          FROM prescription_item pi
                         WHERE ${collateEq('pi.id_prescription', 'p.id_prescription')}
                           AND ${collateEq('pi.id_business', 'p.id_business')}
                    ) AS medications
                   FROM prescription p
                   INNER JOIN person ON ${collateEq('person.id_person', 'p.id_person')} AND ${collateEq('person.id_business', 'p.id_business')}
                   LEFT JOIN login doctor ON ${collateEq('doctor.id_login', 'p.issuer_doctor_id')}
                   LEFT JOIN doctor_professional_profile dpp ON ${collateEq('dpp.id_login', 'p.issuer_doctor_id')} AND ${collateEq('dpp.id_business', 'p.id_business')}
                   LEFT JOIN login creator ON ${collateEq('creator.id_login', 'p.created_by')}
                   LEFT JOIN login issuer ON ${collateEq('issuer.id_login', 'p.issued_by')}
                   LEFT JOIN login canceller ON ${collateEq('canceller.id_login', 'p.cancelled_by')}
                  WHERE ${where.join(' AND ')}
                  ORDER BY p.issue_date DESC, p.created_at DESC, p.id_prescription DESC${paging ? ' LIMIT :_limit OFFSET :_offset' : ''}`,
                { replacements, type: QueryTypes.SELECT }
            );

            return responseData.success(paging ? pageData(result.map(withPatientIdentity), pagination) : result.map(withPatientIdentity), Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            if (error.message === 'INVALID_LIST_PAGE') return responseData.bad_request('Pagina o tamano de pagina invalido.');
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async getById(body) {
        try {
            const access = await this.getViewAccess(body.id_login);
            if (!access.canViewOwn && !access.canViewAll) {
                return responseData.unauthorized('No tienes permiso para consultar recetas.');
            }

            const prescription = await this.getPrescription(body.id_prescription, body.id_business);
            if (!prescription) {
                return responseData.notSuccess('Receta no encontrada.');
            }

            if (!access.canViewAll && prescription.issuer_doctor_id !== body.id_login && prescription.created_by !== body.id_login) {
                return responseData.unauthorized('No tienes permiso para consultar esta receta.');
            }

            const items = await this.getItems(body.id_prescription, body.id_business);
            prescription.items = items;

            return responseData.success(prescription, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async save(body) {
        const transaction = await sequelize.transaction();
        try {
            if (!body.id_business) {
                await transaction.rollback();
                return responseData.unauthorized('No hay negocio activo para guardar recetas.');
            }

            const payload = body.prescription || body;
            const isUpdate = Boolean(payload.id_prescription);
            const createRequestId = !isUpdate ? payload.create_request_id : null;
            if (createRequestId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(createRequestId)) {
                await transaction.rollback();
                return responseData.bad_request('Identificador de captura de receta invalido.');
            }
            const permission = isUpdate ? PERMISSIONS.EDIT_DRAFT : PERMISSIONS.CREATE;
            const canSave = await this.hasPermission(body.id_login, permission, transaction);
            if (!canSave) {
                await transaction.rollback();
                return responseData.unauthorized('No tienes permiso para guardar recetas.');
            }

            const patient = await this.getPatient(payload.id_person, body.id_business, transaction);
            if (!patient) {
                await transaction.rollback();
                return responseData.unauthorized('El paciente no pertenece al negocio activo.');
            }

            const doctor = await this.getDoctor(payload.issuer_doctor_id, body.id_business, transaction);
            if (!doctor) {
                await transaction.rollback();
                return responseData.bad_request('Doctor emisor invalido.');
            }

            const idPrescription = payload.id_prescription || createRequestId || uuidv4();
            if (createRequestId) {
                // Serialize retries for this patient's capture. The browser preserves
                // this UUID when the first committed response is lost.
                await sequelize.query(`SELECT id_person FROM person WHERE ${collateEq('id_person', ':_id_person')}
                    AND ${collateEq('id_business', ':_id_business')} FOR UPDATE`, {
                    replacements: { _id_person: payload.id_person, _id_business: body.id_business }, type: QueryTypes.SELECT, transaction
                });
                const existing = await sequelize.query(`SELECT * FROM prescription WHERE ${collateEq('id_prescription', ':_id_prescription')}
                    AND ${collateEq('id_business', ':_id_business')} FOR UPDATE`, {
                    replacements: { _id_prescription: idPrescription, _id_business: body.id_business }, type: QueryTypes.SELECT, transaction
                });
                if (existing[0]) {
                    const current = existing[0];
                    const items = await this.getItems(idPrescription, body.id_business, transaction, true);
                    const matches = current.active === 1 && current.created_by === body.id_login
                        && current.status !== STATUS.CANCELLED && this.matchesCreateRequest(payload, current, items);
                    await transaction.rollback();
                    if (!matches) return { status: 409, data: { code: 'PRESCRIPTION_CREATE_CONFLICT' },
                        message: 'Esta captura de receta ya se guardo con otro contenido o estado. Revisa la receta existente antes de continuar.' };
                    return this.getById({ id_prescription: idPrescription, id_business: body.id_business, id_login: body.id_login });
                }
            }
            let folio = payload.folio;
            let previousStatus = null;

            if (isUpdate) {
                const current = await this.getPrescription(idPrescription, body.id_business, transaction, true);
                if (!current) {
                    await transaction.rollback();
                    return responseData.notSuccess('Receta no encontrada.');
                }

                previousStatus = current.status;
                if (current.status !== STATUS.DRAFT) {
                    await transaction.rollback();
                    return responseData.bad_request('Solo se pueden editar recetas en borrador.');
                }

                folio = current.folio;
                await sequelize.query(
                    `UPDATE prescription
                        SET id_person = :_id_person,
                            issuer_doctor_id = :_issuer_doctor_id,
                            issue_date = :_issue_date,
                            diagnosis = :_diagnosis,
                            notes = :_notes,
                            previous_prescription_id = :_previous_prescription_id,
                            updated_at = NOW(),
                            updated_by = :_id_login
                      WHERE ${collateEq('id_prescription', ':_id_prescription')}
                        AND ${collateEq('id_business', ':_id_business')}
                        AND ${collateEq('status', "'draft'")}`,
                    {
                        replacements: this.prescriptionReplacements(payload, body, idPrescription, folio),
                        type: QueryTypes.UPDATE,
                        transaction
                    }
                );
            } else {
                folio = await this.nextFolio(body.id_business, payload.issue_date, transaction);
                await sequelize.query(
                    `INSERT INTO prescription (
                        id_prescription, id_business, id_person, issuer_doctor_id, created_by,
                        folio, status, issue_date, diagnosis, notes, previous_prescription_id,
                        active, created_at
                    ) VALUES (
                        :_id_prescription, :_id_business, :_id_person, :_issuer_doctor_id, :_id_login,
                        :_folio, 'draft', :_issue_date, :_diagnosis, :_notes, :_previous_prescription_id,
                        1, NOW()
                    )`,
                    {
                        replacements: this.prescriptionReplacements(payload, body, idPrescription, folio),
                        type: QueryTypes.INSERT,
                        transaction
                    }
                );
            }

            await this.replaceItems(idPrescription, body.id_business, payload.items || [], transaction);
            await this.audit({
                id_business: body.id_business,
                id_prescription: idPrescription,
                id_user: body.id_login,
                action: isUpdate ? 'updated_draft' : 'created',
                previous_status: previousStatus,
                new_status: STATUS.DRAFT,
                metadata: { folio }
            }, transaction);

            await transaction.commit();
            return this.getById({
                id_prescription: idPrescription,
                id_business: body.id_business,
                id_login: body.id_login
            });
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async getPatientIdentity(idPerson, idBusiness, transaction) {
        const rows = await sequelize.query(`SELECT TRIM(CONCAT(IFNULL(name,''),' ',IFNULL(surname,''))) AS patient_name,
            DATE_FORMAT(birthday,'%Y-%m-%d') AS patient_birthday, age AS patient_age
            FROM person WHERE id_person = :patient AND id_business = :business FOR SHARE`, {
            replacements: { patient: idPerson, business: idBusiness }, type: QueryTypes.SELECT, transaction
        });
        return rows[0] || null;
    }

    async issue(body) {
        const transaction = await sequelize.transaction();
        try {
            const canIssue = await this.hasPermission(body.id_login, PERMISSIONS.ISSUE, transaction);
            if (!canIssue) {
                await transaction.rollback();
                return responseData.unauthorized('No tienes permiso para emitir recetas.');
            }

            // Serialize emission attempts, including a retry after a lost HTTP response.
            await sequelize.query(
                `SELECT id_prescription FROM prescription
                  WHERE ${collateEq('id_prescription', ':_id_prescription')}
                    AND ${collateEq('id_business', ':_id_business')} AND active = 1
                  FOR UPDATE`,
                { replacements: { _id_prescription: body.id_prescription, _id_business: body.id_business }, type: QueryTypes.SELECT, transaction }
            );
            const prescription = await this.getPrescription(body.id_prescription, body.id_business, transaction, true);
            if (!prescription) {
                await transaction.rollback();
                return responseData.notSuccess('Receta no encontrada.');
            }

            if (prescription.status === STATUS.ISSUED && prescription.issuer_doctor_id === body.id_login && prescription.issued_by === body.id_login) {
                await transaction.commit();
                return this.getById(body);
            }
            if (prescription.status !== STATUS.DRAFT) {
                await transaction.rollback();
                return responseData.bad_request('Solo se pueden emitir recetas en borrador.');
            }

            const business = await this.getBusiness(body.id_business, transaction);
            if (!business || business.active !== 1 || business.status !== 'active') {
                await transaction.rollback();
                return responseData.unauthorized('El negocio no esta activo para emitir recetas.');
            }

            const items = await this.getItems(body.id_prescription, body.id_business, transaction, true);
            const itemValidation = this.validateItemsForIssue(items);
            if (!itemValidation.isValid) {
                await transaction.rollback();
                return responseData.bad_request(itemValidation.message);
            }

            const config = await this.getRawConfig(body.id_business, transaction, prescription.issuer_doctor_id);
            const configValidation = this.validateConfigForIssue(config);
            if (!configValidation.isValid) {
                await transaction.rollback();
                return responseData.bad_request(configValidation.message);
            }

            const doctor = await this.getDoctor(prescription.issuer_doctor_id, body.id_business, transaction);
            if (!doctor) {
                await transaction.rollback();
                return responseData.bad_request('Doctor emisor invalido.');
            }

            const actor = await this.getDoctor(body.id_login, body.id_business, transaction);
            if (!actor) {
                await transaction.rollback();
                return responseData.unauthorized('Solo un doctor con perfil profesional puede emitir recetas.');
            }
            if (actor && actor.id_login !== prescription.issuer_doctor_id) {
                await transaction.rollback();
                return responseData.unauthorized('No puedes emitir recetas con otro doctor emisor.');
            }

            const profileValidation = this.validateDoctorProfileForIssue(doctor);
            if (!profileValidation.isValid) {
                await transaction.rollback();
                return responseData.bad_request(profileValidation.message);
            }

            const patientIdentity = await this.getPatientIdentity(prescription.id_person, body.id_business, transaction);
            if (!patientIdentity) { await transaction.rollback(); return responseData.notSuccess('Paciente no encontrado.'); }
            await sequelize.query(
                `UPDATE prescription
                    SET status = 'issued',
                        issued_by = :_id_login,
                        issued_at = NOW(),
                        issuer_doctor_profile_id = :_issuer_doctor_profile_id,
                        doctor_name_snapshot = :_doctor_name,
                        professional_license_snapshot = :_professional_license,
                        university_snapshot = :_university,
                        specialty_snapshot = :_specialty,
                        specialty_license_snapshot = :_specialty_license,
                        professional_phone_snapshot = :_professional_phone,
                        clinic_name_snapshot = :_clinic_name,
                        clinic_address_snapshot = :_clinic_address,
                        clinic_phone_snapshot = :_clinic_phone,
                        signature_snapshot = :_signature_image,
                        header_image_snapshot = :_header_image,
                        background_image_snapshot = :_background_image,
                        footer_note_snapshot = :_footer_note,
                        template_snapshot = :_template_snapshot,
                        updated_at = NOW(),
                        updated_by = :_id_login
                  WHERE ${collateEq('id_prescription', ':_id_prescription')}
                    AND ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('status', "'draft'")}`,
                {
                    replacements: {
                        _id_prescription: body.id_prescription,
                        _id_business: body.id_business,
                        _id_login: body.id_login,
                        _issuer_doctor_profile_id: doctor.id_doctor_professional_profile,
                        _doctor_name: doctor.professional_name,
                        _professional_license: doctor.professional_license,
                        _university: doctor.university,
                        _specialty: doctor.specialty,
                        _specialty_license: doctor.specialty_license,
                        _professional_phone: doctor.professional_phone,
                        _clinic_name: config.clinic_name,
                        _clinic_address: config.clinic_address,
                        _clinic_phone: config.clinic_phone,
                        _signature_image: doctor.signature_image,
                        _header_image: config.header_image,
                        _background_image: config.background_image,
                        _footer_note: config.footer_note,
                        _template_snapshot: JSON.stringify({
                            patient_identity: snapshotPatient(patientIdentity),
                            template_mode: config.template_mode || 'header',
                            background_opacity: config.background_opacity,
                            show_specialty: Boolean(config.show_specialty),
                            show_university: Boolean(config.show_university),
                            show_footer_note: Boolean(config.show_footer_note)
                        })
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await this.audit({
                id_business: body.id_business,
                id_prescription: body.id_prescription,
                id_user: body.id_login,
                action: 'issued',
                previous_status: STATUS.DRAFT,
                new_status: STATUS.ISSUED
            }, transaction);

            await transaction.commit();
            return this.getById(body);
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async cancel(body) {
        const transaction = await sequelize.transaction();
        try {
            const canCancel = await this.hasPermission(body.id_login, PERMISSIONS.CANCEL, transaction);
            if (!canCancel) {
                await transaction.rollback();
                return responseData.unauthorized('No tienes permiso para cancelar recetas.');
            }

            const prescription = await this.getPrescription(body.id_prescription, body.id_business, transaction, true);
            if (!prescription) {
                await transaction.rollback();
                return responseData.notSuccess('Receta no encontrada.');
            }

            if (prescription.status !== STATUS.ISSUED) {
                await transaction.rollback();
                return responseData.bad_request('Solo se pueden cancelar recetas emitidas.');
            }

            const reason = body.reason || body.cancellation_reason;
            await sequelize.query(
                `UPDATE prescription
                    SET status = 'cancelled',
                        cancelled_by = :_id_login,
                        cancelled_at = NOW(),
                        cancellation_reason = :_reason,
                        updated_at = NOW(),
                        updated_by = :_id_login
                  WHERE ${collateEq('id_prescription', ':_id_prescription')}
                    AND ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('status', "'issued'")}`,
                {
                    replacements: {
                        _id_prescription: body.id_prescription,
                        _id_business: body.id_business,
                        _id_login: body.id_login,
                        _reason: reason
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await this.audit({
                id_business: body.id_business,
                id_prescription: body.id_prescription,
                id_user: body.id_login,
                action: 'cancelled',
                previous_status: STATUS.ISSUED,
                new_status: STATUS.CANCELLED,
                reason
            }, transaction);

            await transaction.commit();
            return this.getById(body);
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async deleteDraft(body) {
        let transaction;
        try {
            const canEdit = await this.hasPermission(body.id_login, PERMISSIONS.EDIT_DRAFT);
            if (!canEdit) {
                return responseData.unauthorized('No tienes permiso para eliminar borradores.');
            }

            transaction = await sequelize.transaction();
            const prescription = await this.getPrescription(body.id_prescription, body.id_business, transaction, true);
            if (!prescription) {
                await transaction.rollback();
                return responseData.notSuccess('Receta no encontrada.');
            }

            if (prescription.status !== STATUS.DRAFT) {
                await transaction.rollback();
                return responseData.bad_request('No se pueden eliminar recetas emitidas o canceladas.');
            }

            await sequelize.query(
                `UPDATE prescription
                    SET active = 0,
                        updated_at = NOW(),
                        updated_by = :_id_login
                  WHERE ${collateEq('id_prescription', ':_id_prescription')}
                    AND ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('status', "'draft'")}`,
                {
                    replacements: {
                        _id_prescription: body.id_prescription,
                        _id_business: body.id_business,
                        _id_login: body.id_login
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await this.audit({
                id_business: body.id_business,
                id_prescription: body.id_prescription,
                id_user: body.id_login,
                action: 'deleted_draft',
                previous_status: STATUS.DRAFT,
                new_status: STATUS.DRAFT
            }, transaction);

            await transaction.commit();
            transaction = null;
            return responseData.success({ id_prescription: body.id_prescription }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            if (transaction) await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async doctors(id_business, idLogin) {
        try {
            const access = await this.getViewAccess(idLogin);
            if (!access.canViewOwn && !access.canViewAll && !await this.hasPermission(idLogin, PERMISSIONS.CREATE) && !await this.hasPermission(idLogin, PERMISSIONS.CONFIG)) {
                return responseData.forbidden('No tienes permiso para consultar doctores de recetas.');
            }
            const result = await sequelize.query(
                `SELECT
                    l.id_login,
                    l.name,
                    l.email,
                    l.telephone,
                    r.code AS rol,
                    dpp.id_doctor_professional_profile,
                    dpp.professional_name,
                    dpp.professional_license,
                    dpp.university,
                    dpp.specialty,
                    dpp.specialty_license,
                    dpp.professional_phone,
                    dpp.signature_image,
                    dpp.can_issue_prescriptions,
                    dpp.can_sign_documents,
                    dpp.is_active AS professional_profile_active,
                    CASE
                        WHEN dpp.id_doctor_professional_profile IS NOT NULL
                         AND dpp.is_active = 1
                         AND dpp.can_issue_prescriptions = 1
                         AND IFNULL(dpp.professional_name, '') <> ''
                         AND IFNULL(dpp.professional_license, '') <> ''
                         AND IFNULL(dpp.signature_image, '') <> ''
                        THEN 1 ELSE 0
                    END AS professional_profile_complete
                   FROM login l
                   INNER JOIN rol r ON ${collateEq('r.id_rol', 'l.id_rol')}
                   LEFT JOIN doctor_professional_profile dpp
                     ON ${collateEq('dpp.id_login', 'l.id_login')}
                    AND ${collateEq('dpp.id_business', 'l.id_business')}
                  WHERE l.active = 1
                    AND ${collateEq('l.id_business', ':_id_business')}
                    AND r.code COLLATE ${TENANT_COLLATION} IN ('doctor', 'admin', 'business_admin')
                  ORDER BY l.name ASC`,
                {
                    replacements: { _id_business: id_business },
                    type: QueryTypes.SELECT
                }
            );

            return responseData.success(result, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async prepareOutput(body, includeContent = true) {
        let transaction;
        try {
            if (!['printed', 'downloaded', 'pdf_generated'].includes(body.action)) return responseData.bad_request('Acción de receta inválida.');
            if (!body.id_business) return responseData.forbidden('No hay consultorio activo.');
            const permission = body.action === 'printed' ? PERMISSIONS.PRINT : PERMISSIONS.DOWNLOAD;
            const canAudit = await this.hasPermission(body.id_login, permission);
            const access = await this.getViewAccess(body.id_login);
            if (!canAudit || (!access.canViewOwn && !access.canViewAll)) return responseData.forbidden('No tienes permiso para imprimir o generar PDF de esta receta.');

            transaction = await sequelize.transaction();
            // Serialize output authorization with issue/cancel. Never use a previously loaded DTO.
            await sequelize.query(`SELECT id_prescription FROM prescription WHERE ${collateEq('id_prescription', ':_id_prescription')}
                AND ${collateEq('id_business', ':_id_business')} AND active = 1 FOR UPDATE`, {
                replacements: { _id_prescription: body.id_prescription, _id_business: body.id_business }, type: QueryTypes.SELECT, transaction
            });
            const prescription = await this.getPrescription(body.id_prescription, body.id_business, transaction, true);
            if (!prescription) {
                await transaction.rollback();
                return responseData.notSuccess('Receta no encontrada.');
            }
            if (!access.canViewAll && prescription.issuer_doctor_id !== body.id_login && prescription.created_by !== body.id_login) {
                await transaction.rollback();
                return responseData.forbidden('No tienes permiso para consultar esta receta.');
            }
            if (prescription.status !== STATUS.ISSUED) {
                await transaction.rollback();
                return responseData.bad_request(prescription.status === STATUS.CANCELLED
                    ? 'Esta receta está cancelada. Solo puedes consultarla en el histórico; no se permite imprimir ni generar PDF.'
                    : 'Solo las recetas emitidas pueden imprimirse o generar PDF. Emite la receta antes de continuar.', {
                    id_prescription: prescription.id_prescription, status: prescription.status,
                    cancellation_reason: prescription.cancellation_reason || null, cancelled_at: prescription.cancelled_at || null
                });
            }
            let content;
            if (includeContent) content = {
                prescription: { ...prescription, items: await this.getItems(body.id_prescription, body.id_business, transaction, true) },
                config: await this.getRawConfig(body.id_business, transaction, prescription.issuer_doctor_id) || {}
            };

            await this.audit({
                id_business: body.id_business,
                id_prescription: body.id_prescription,
                id_user: body.id_login,
                action: body.action,
                previous_status: prescription.status,
                new_status: prescription.status,
                metadata: body.metadata || null
            }, transaction);

            await transaction.commit();
            transaction = null;
            return responseData.success(content || { id_prescription: body.id_prescription, action: body.action }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            if (transaction) await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async auditAction(body) { return this.prepareOutput(body, false); }

    prescriptionReplacements(payload, body, idPrescription, folio) {
        return {
            _id_prescription: idPrescription,
            _id_business: body.id_business,
            _id_person: payload.id_person,
            _issuer_doctor_id: payload.issuer_doctor_id,
            _id_login: body.id_login,
            _folio: folio,
            _issue_date: payload.issue_date || new Date().toISOString().slice(0, 10),
            _diagnosis: payload.diagnosis || null,
            _notes: payload.notes || null,
            _previous_prescription_id: payload.previous_prescription_id || null
        };
    }

    matchesCreateRequest(payload, current, storedItems) {
        const text = value => value === null || value === undefined || value === '' ? '' : String(value);
        const date = value => value instanceof Date
            ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
            : text(value).slice(0, 10);
        for (const field of ['id_person', 'issuer_doctor_id', 'diagnosis', 'notes', 'previous_prescription_id']) {
            if (text(payload[field]) !== text(current[field])) return false;
        }
        if (date(payload.issue_date || new Date().toISOString().slice(0, 10)) !== date(current.issue_date)) return false;
        const fields = ['generic_name', 'commercial_name', 'presentation', 'concentration', 'pharmaceutical_form',
            'dose', 'administration_route', 'frequency', 'duration', 'quantity', 'indications'];
        const normalize = items => (items || []).map((item, index) => ({
            order: Number(item.sort_order || index + 1), values: fields.map(field => text(item[field]))
        })).sort((a, b) => a.order - b.order);
        return JSON.stringify(normalize(payload.items)) === JSON.stringify(normalize(storedItems));
    }

    async replaceItems(idPrescription, idBusiness, items, transaction) {
        await sequelize.query(
            `DELETE FROM prescription_item
              WHERE ${collateEq('id_prescription', ':_id_prescription')}
                AND ${collateEq('id_business', ':_id_business')}`,
            {
                replacements: {
                    _id_prescription: idPrescription,
                    _id_business: idBusiness
                },
                type: QueryTypes.DELETE,
                transaction
            }
        );

        for (let index = 0; index < items.length; index += 1) {
            const item = items[index] || {};
            await sequelize.query(
                `INSERT INTO prescription_item (
                    id_prescription_item, id_prescription, id_business, generic_name, commercial_name,
                    presentation, concentration, pharmaceutical_form, dose, administration_route,
                    frequency, duration, quantity, indications, sort_order, created_at
                ) VALUES (
                    :_id_prescription_item, :_id_prescription, :_id_business, :_generic_name, :_commercial_name,
                    :_presentation, :_concentration, :_pharmaceutical_form, :_dose, :_administration_route,
                    :_frequency, :_duration, :_quantity, :_indications, :_sort_order, NOW()
                )`,
                {
                    replacements: {
                        _id_prescription_item: item.id_prescription_item || uuidv4(),
                        _id_prescription: idPrescription,
                        _id_business: idBusiness,
                        _generic_name: item.generic_name || '',
                        _commercial_name: item.commercial_name || null,
                        _presentation: item.presentation || null,
                        _concentration: item.concentration || null,
                        _pharmaceutical_form: item.pharmaceutical_form || null,
                        _dose: item.dose || '',
                        _administration_route: item.administration_route || '',
                        _frequency: item.frequency || '',
                        _duration: item.duration || '',
                        _quantity: item.quantity || null,
                        _indications: item.indications || null,
                        _sort_order: item.sort_order || index + 1
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );
        }
    }

    async nextFolio(idBusiness, issueDate, transaction) {
        const year = Number((issueDate || new Date().toISOString()).slice(0, 4));
        await sequelize.query(
            `INSERT INTO prescription_folio_counter (id_business, folio_year, current_value, updated_at)
             VALUES (:_id_business, :_year, 0, NOW())
             ON DUPLICATE KEY UPDATE updated_at = updated_at`,
            {
                replacements: { _id_business: idBusiness, _year: year },
                type: QueryTypes.INSERT,
                transaction
            }
        );

        await sequelize.query(
            `UPDATE prescription_folio_counter
                SET current_value = LAST_INSERT_ID(current_value + 1),
                    updated_at = NOW()
              WHERE ${collateEq('id_business', ':_id_business')}
                AND folio_year = :_year`,
            {
                replacements: { _id_business: idBusiness, _year: year },
                type: QueryTypes.UPDATE,
                transaction
            }
        );

        const sequence = await sequelize.query('SELECT LAST_INSERT_ID() AS seq', {
            type: QueryTypes.SELECT,
            transaction
        });

        return `RX-${year}-${String(sequence[0].seq).padStart(6, '0')}`;
    }

    async getViewAccess(idLogin) {
        const [canViewAll, canViewOwn] = await Promise.all([
            this.hasPermission(idLogin, PERMISSIONS.VIEW_ALL),
            this.hasPermission(idLogin, PERMISSIONS.VIEW_OWN)
        ]);

        return { canViewAll, canViewOwn };
    }

    async hasPermission(idLogin, permission, transaction = null) {
        return effectivePermissions.hasPermission(idLogin, permission, {enabledCatalog:false, transaction});
    }

    async getPatient(idPerson, idBusiness, transaction = null) {
        const result = await sequelize.query(
            `SELECT id_person, name, surname, birthday, age, telephone
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
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return result[0] || null;
    }

    async getBusiness(idBusiness, transaction = null) {
        const result = await sequelize.query(
            `SELECT id_business, status, active
               FROM business
              WHERE ${collateEq('id_business', ':_id_business')}
              LIMIT 1`,
            {
                replacements: { _id_business: idBusiness },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return result[0] || null;
    }

    async getDoctor(idLogin, idBusiness, transaction = null) {
        const result = await sequelize.query(
            `SELECT
                l.id_login,
                l.name,
                r.code AS rol,
                dpp.id_doctor_professional_profile,
                dpp.professional_name,
                dpp.professional_license,
                dpp.university,
                dpp.specialty,
                dpp.specialty_license,
                dpp.professional_phone,
                dpp.signature_image,
                dpp.can_issue_prescriptions,
                dpp.can_sign_documents,
                dpp.is_active AS professional_profile_active
               FROM login l
               INNER JOIN rol r ON ${collateEq('r.id_rol', 'l.id_rol')}
               LEFT JOIN doctor_professional_profile dpp
                 ON ${collateEq('dpp.id_login', 'l.id_login')}
                AND ${collateEq('dpp.id_business', 'l.id_business')}
              WHERE ${collateEq('l.id_login', ':_id_login')}
                AND ${collateEq('l.id_business', ':_id_business')}
                AND l.active = 1
                AND r.code COLLATE ${TENANT_COLLATION} IN ('doctor', 'admin', 'business_admin')
              LIMIT 1`,
            {
                replacements: {
                    _id_login: idLogin,
                    _id_business: idBusiness
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return result[0] || null;
    }

    async getPrescription(idPrescription, idBusiness, transaction = null, lock = false) {
        let current = null;
        if (lock) {
            // Lock only the prescription, not the presentation joins. A plain
            // repeatable-read projection below may be older; current owns all
            // persisted prescription fields and the issued doctor's snapshot.
            const rows = await sequelize.query(`SELECT * FROM prescription
                WHERE ${collateEq('id_prescription', ':_id_prescription')}
                  AND ${collateEq('id_business', ':_id_business')} AND active = 1 LIMIT 1 FOR UPDATE`, {
                replacements: { _id_prescription: idPrescription, _id_business: idBusiness }, type: QueryTypes.SELECT, transaction
            });
            if (!rows[0]) return null;
            current = rows[0];
        }
        const result = await sequelize.query(
            `SELECT p.*,
                    TRIM(CONCAT(IFNULL(person.name, ''), ' ', IFNULL(person.surname, ''))) AS patient_name,
                    person.birthday AS patient_birthday,
                    person.age AS patient_age,
                    COALESCE(p.doctor_name_snapshot, dpp.professional_name, doctor.name) AS doctor_name,
                    creator.name AS created_by_name,
                    issuer.name AS issued_by_name,
                    canceller.name AS cancelled_by_name
               FROM prescription p
               INNER JOIN person ON ${collateEq('person.id_person', 'p.id_person')} AND ${collateEq('person.id_business', 'p.id_business')}
               LEFT JOIN login doctor ON ${collateEq('doctor.id_login', 'p.issuer_doctor_id')}
               LEFT JOIN doctor_professional_profile dpp ON ${collateEq('dpp.id_login', 'p.issuer_doctor_id')} AND ${collateEq('dpp.id_business', 'p.id_business')}
               LEFT JOIN login creator ON ${collateEq('creator.id_login', 'p.created_by')}
               LEFT JOIN login issuer ON ${collateEq('issuer.id_login', 'p.issued_by')}
               LEFT JOIN login canceller ON ${collateEq('canceller.id_login', 'p.cancelled_by')}
              WHERE ${collateEq('p.id_prescription', ':_id_prescription')}
                AND ${collateEq('p.id_business', ':_id_business')}
                AND p.active = 1
              LIMIT 1`,
            {
                replacements: {
                    _id_prescription: idPrescription,
                    _id_business: idBusiness
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        if (current) return withPatientIdentity({ ...result[0], ...current, doctor_name: current.doctor_name_snapshot || (result[0] && result[0].doctor_name) || null });
        return withPatientIdentity(result[0] || null);
    }

    async getItems(idPrescription, idBusiness, transaction = null, lock = false) {
        return sequelize.query(
            `SELECT *
               FROM prescription_item
              WHERE ${collateEq('id_prescription', ':_id_prescription')}
                AND ${collateEq('id_business', ':_id_business')}
              ORDER BY sort_order ASC, created_at ASC${lock ? ' FOR UPDATE' : ''}`,
            {
                replacements: {
                    _id_prescription: idPrescription,
                    _id_business: idBusiness
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );
    }

    async getRawConfig(idBusiness, transaction = null, doctorLoginId = null) {
        const result = await sequelize.query(
            `SELECT *
               FROM prescription_config
              WHERE ${collateEq('id_business', ':_id_business')}
                AND doctor_profile_id = (SELECT id_doctor_professional_profile FROM doctor_professional_profile WHERE id_business COLLATE utf8mb4_unicode_ci = :_id_business COLLATE utf8mb4_unicode_ci AND id_login COLLATE utf8mb4_unicode_ci = :_doctor_login COLLATE utf8mb4_unicode_ci LIMIT 1)
                AND active = 1
              LIMIT 1`,
            {
                replacements: { _id_business: idBusiness, _doctor_login: doctorLoginId },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return result[0] || null;
    }

    validateConfigForIssue(config) {
        if (!config) {
            return { isValid: false, message: 'Configura los datos de receta antes de emitir.' };
        }

        const required = [
            ['clinic_address', 'Domicilio del consultorio requerido.'],
            ['clinic_phone', 'Telefono de contacto requerido.']
        ];

        for (const [field, message] of required) {
            if (!config[field]) {
                return { isValid: false, message };
            }
        }

        return { isValid: true };
    }

    validateDoctorProfileForIssue(profile) {
        if (!profile || !profile.id_doctor_professional_profile) {
            return { isValid: false, message: PROFESSIONAL_PROFILE_MESSAGE };
        }

        if (Number(profile.professional_profile_active) !== 1) {
            return { isValid: false, message: 'El perfil profesional del doctor esta inactivo.' };
        }

        if (Number(profile.can_issue_prescriptions) !== 1) {
            return { isValid: false, message: 'El doctor no tiene permiso profesional para emitir recetas.' };
        }

        const required = ['professional_name', 'professional_license', 'signature_image'];
        const hasMissing = required.some((field) => !profile[field]);
        if (hasMissing) {
            return { isValid: false, message: PROFESSIONAL_PROFILE_MESSAGE };
        }

        return { isValid: true };
    }

    validateItemsForIssue(items) {
        if (!items || items.length === 0) {
            return { isValid: false, message: 'Agrega al menos un medicamento.' };
        }

        const required = [
            ['generic_name', 'Nombre generico requerido.'],
            ['dose', 'Dosis requerida.'],
            ['administration_route', 'Via de administracion requerida.'],
            ['frequency', 'Frecuencia requerida.'],
            ['duration', 'Duracion requerida.']
        ];

        for (const item of items) {
            for (const [field, message] of required) {
                if (!item[field]) {
                    return { isValid: false, message };
                }
            }
        }

        return { isValid: true };
    }

    async audit(entry, transaction = null) {
        await sequelize.query(
            `INSERT INTO prescription_audit_log (
                id_prescription_audit_log, id_business, id_prescription, id_user,
                action, previous_status, new_status, reason, metadata, created_at
            ) VALUES (
                :_id_prescription_audit_log, :_id_business, :_id_prescription, :_id_user,
                :_action, :_previous_status, :_new_status, :_reason, :_metadata, NOW()
            )`,
            {
                replacements: {
                    _id_prescription_audit_log: uuidv4(),
                    _id_business: entry.id_business,
                    _id_prescription: entry.id_prescription,
                    _id_user: entry.id_user || null,
                    _action: entry.action,
                    _previous_status: entry.previous_status || null,
                    _new_status: entry.new_status || null,
                    _reason: entry.reason || null,
                    _metadata: entry.metadata ? JSON.stringify(entry.metadata) : null
                },
                type: QueryTypes.INSERT,
                transaction
            }
        );
    }
}

module.exports = new PrescriptionDao();

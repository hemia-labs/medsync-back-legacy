const { userNames } = require('../../util/userNames');
const { beginLicenseMutation } = require('../../util/licenseMutation');
const privateImages = require('../../services/aws/privateImages');
const effectivePermissions = require('../../util/effectivePermissions');
const { seedTracingPermissions } = require('../../util/tracingPermissions');
const { seedDashboardPermissions } = require('../../util/dashboardAccess');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');
const { encript } = require('../../util/bcrypt')
const {v4: uuidv4 } = require('uuid');
const LicenseUsageDao = require('./licenseUsage.dao');
const { validateProfessionalPhone } = require('../../validators/professionalProfile.validator');
const {
    classifyLicenseResource,
    validateLicenseForNewUser,
    validateLicenseForProfessionalProfile,
    validateLicenseTransition
} = require('../../util/licenseLimits');

function tenantAssignable(role) {
    const code = String(role && role.code || '').trim().toLowerCase();
    return [...LicenseUsageDao.PROFESSIONAL_ROLE_CODES, ...LicenseUsageDao.AUXILIARY_ROLE_CODES].includes(code);
}

function normalizeUpdateActive(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback === true || fallback === 1;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value).trim().toLowerCase();
    return ['1', 'true', 'active', 'activo'].includes(normalized);
}

function pickValue(value, fallback) {
    return value === undefined || value === null ? fallback : value;
}

async function addUserNames(rows, business, superAdmin) {
    const ids = rows.map(row => row.id_login).filter(Boolean);
    if (!ids.length) return rows;
    const names = await sequelize.query(
        'SELECT id_login,first_name,last_name FROM login WHERE id_login IN (:ids) AND (:superAdmin=1 OR id_business=:business)',
        { replacements: { ids, superAdmin: superAdmin ? 1 : 0, business: business || null }, type: QueryTypes.SELECT }
    );
    const byId = new Map(names.map(row => [row.id_login, row]));
    return rows.map(row => ({ ...row, first_name: byId.get(row.id_login)?.first_name || row.name || '', last_name: byId.get(row.id_login)?.last_name || '' }));
}

/**
 * Clase principal
 */
class UserDao{

/**
 * Permite registrar un nuevo usuario
 * @returns Lista de paises
 */
 async saveUser(body) {
    let transaction = null;
    let response;        
    try {
        const names = userNames(body);
        if (!names) return responseData.bad_request('Escribe nombre y apellidos válidos, hasta 200 caracteres en total.');
        const existingUser = await sequelize.query(
            'SELECT id_login FROM login WHERE (telephone = :_telephone OR email = :_email) AND active = 1 LIMIT 1',
            {
                replacements: {
                    _telephone: body.phone,
                    _email: body.email
                },
                transaction, type: QueryTypes.SELECT
            }
        );

        if (existingUser && existingUser.length > 0) {
            return responseData.bad_request('Ya existe un usuario activo con ese telefono o correo.');
        }

        const role = await sequelize.query(
            'SELECT id_rol, code FROM rol WHERE id_rol = :_id_rol AND active = 1 LIMIT 1',
            {
                replacements: {
                    _id_rol: body.id_rol
                },
                transaction, type: QueryTypes.SELECT
            }
        );

        if (!role || role.length === 0) {
            return responseData.bad_request('Id rol invalido.');
        }

        if (!tenantAssignable(role[0])) return responseData.forbidden('Rol no asignable a usuarios del consultorio.');
        transaction = await beginLicenseMutation(sequelize, body.id_business);
        const licenseValidation = await validateLicenseForNewUser(body.id_business, role[0], body.id_login || null, transaction);
        if (licenseValidation && licenseValidation.allowed === false) {
            await transaction.commit(); transaction = null;
            return licenseValidation.response;
        }
        if (licenseValidation && licenseValidation.status) {
            return licenseValidation;
        }

        const idLogin = uuidv4();
        let pwd = await encript(body.password);

        await sequelize.query(
            `INSERT INTO login (
                id_login,
                id_rol,
                name,
                first_name,
                last_name,
                email,
                telephone,
                password,
                active,
                locked,
                created_at,
                created_by,
                updated_at,
                updated_by,
                id_business
            ) VALUES (
                :_id_login,
                :_id_rol,
                :_name,
                :_first_name,
                :_last_name,
                :_email,
                :_telephone,
                :_password,
                1,
                0,
                NOW(),
                :_created_by,
                NULL,
                NULL,
                :_id_business
            )`,
            {
                replacements: {
                    _id_login: idLogin,
                    _id_rol: body.id_rol,
                    _name: names.name,
                    _first_name: names.first_name,
                    _last_name: names.last_name,
                    _email: body.email,
                    _telephone: body.phone,
                    _password: pwd,
                    _created_by: body.id_login || null,
                    _id_business: body.id_business || null
                },
                transaction, type: QueryTypes.INSERT
            }
        );

        await seedDashboardPermissions(body.id_business, idLogin, transaction);

        await seedTracingPermissions(body.id_business, idLogin, transaction);
        let result = await sequelize.query(
            `SELECT
                l.id_login,
                l.id_rol,
                l.name,
                l.first_name,
                l.last_name,
                l.email,
                l.telephone AS phone,
                l.active
             FROM login l
             WHERE l.id_login = :_id_login`,
            {
                replacements: {
                    _id_login: idLogin
                },
                transaction, type: QueryTypes.SELECT
            }
        );

        await transaction.commit();
        transaction = null;
        response = responseData.success(result[0], Messages.DATA_SAVE_SUCCESSFULLY);
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    } finally {
        if (transaction && !transaction.finished) await transaction.rollback();
    }
    return response;
}

/**
 * Compatibilidad del nombre legado con los controles actuales de rol y cuota.
 */
 async saveUserLegacy(body) { return this.saveUser(body); }

/**
 * Permite actualizar un usuario especifico
 * @param {any} body Payload
 * @param {String} id_login id del usuario a modificar
 * @returns 
 */
async updateUser(body,id_login) {
    let transaction = null;
    let response;        
    try {
        const target = await LicenseUsageDao.getLicenseUserState(body.is_super_admin ? null : body.id_business, id_login);
        if (!target || !target.id_business) return responseData.forbidden('Usuario no disponible para gestion de consultorio.');
        transaction = await beginLicenseMutation(sequelize, target.id_business);
        const currentState = await LicenseUsageDao.getLicenseUserState(body.is_super_admin ? null : body.id_business, id_login, transaction);
        if (!currentState) {
            return responseData.bad_request('Usuario invalido para este negocio.');
        }

        const names = userNames(body, currentState);
        if (!names) return responseData.bad_request('Escribe nombre y apellidos válidos, hasta 200 caracteres en total.');
        const nextRoleId = pickValue(body.id_rol, currentState.id_rol);
        const nextRole = nextRoleId === currentState.id_rol
            ? { id_rol: currentState.id_rol, code: currentState.roleCode }
            : await LicenseUsageDao.getRoleById(nextRoleId, transaction);

        if (!nextRole || !nextRole.code) {
            return responseData.bad_request('Id rol invalido.');
        }

        if (!tenantAssignable(nextRole) || !tenantAssignable({ code: currentState.roleCode })) return responseData.forbidden('Rol no asignable a usuarios del consultorio.');
        const nextActive = normalizeUpdateActive(body.active, currentState.active);
        const currentResource = classifyLicenseResource(currentState, { unknownAsStaff: true });
        const nextResource = classifyLicenseResource({
            ...currentState,
            id_rol: nextRole.id_rol,
            roleCode: nextRole.code,
            active: nextActive ? 1 : 0
        });
        const targetBusiness = currentState.id_business || body.id_business;
        const licenseValidation = await validateLicenseTransition({
            transaction,
            idBusiness: targetBusiness,
            targetLoginId: id_login,
            currentResource,
            nextResource,
            actorLoginId: body.id_login || null,
            roleCode: nextRole.code,
            action: 'user_update'
        });

        if (licenseValidation && licenseValidation.allowed === false) {
            await transaction.commit(); transaction = null;
            return licenseValidation.response;
        }
        if (licenseValidation && licenseValidation.status) {
            return licenseValidation;
        }

        let result = await sequelize.query(`UPDATE login SET id_rol = :_id_rol, name = :_name, first_name = :_first_name, last_name = :_last_name, email = :_email,
            telephone = :_telephone, active = :_active, updated_at = NOW(), updated_by = :_actor
            WHERE id_login = :_id_login AND id_business = :_id_business`, {
            replacements: {
                _actor: body.id_login,
                _id_login : id_login,
                _id_rol : nextRoleId,
                _name : names.name,
                _first_name: names.first_name,
                _last_name: names.last_name,
                _email : pickValue(body.email, currentState.email),
                _telephone : pickValue(body.phone || body.telephone, currentState.telephone),
                _active : nextActive ? 1 : 0,
                _id_business : targetBusiness,
                _is_super_admin : body.is_super_admin ? 1 : 0
            },
            transaction, type: QueryTypes.UPDATE,
            plain: true
        });

        if (!result || !Number(result[1])) return responseData.notSuccess('Usuario no disponible.');
        await seedDashboardPermissions(targetBusiness, id_login, transaction);
        await seedTracingPermissions(targetBusiness, id_login, transaction);
        const rows = await sequelize.query('SELECT id_login, id_rol, name, first_name, last_name, email, telephone, id_business FROM login WHERE id_login = :login AND id_business = :business', {
            replacements: { login: id_login, business: targetBusiness }, type: QueryTypes.SELECT, transaction
        });
        response = responseData.success(rows[0], Messages.DATA_SAVE_SUCCESSFULLY);
        if (response && response.status === 200) { await transaction.commit(); transaction = null; }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    } finally {
        if (transaction && !transaction.finished) await transaction.rollback();
    }
    return response;
}


/**
 * Permite obtener los usuarios del sistema
 * @returns Lista de paises
 */
async list(id_business, is_super_admin = false) {
    let response;        
    try {
        let result = await sequelize.query(SequelizeSP.SP_USER_LIST, {
            replacements: {
                _id : 'na',
                _id_business : id_business,
                _is_super_admin : is_super_admin ? 1 : 0
            },
            type: QueryTypes.RAW,
            plain: true
        });

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(await addUserNames(result, id_business, is_super_admin), Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{/* regresamos una excepción controlada al no obtener una respuesta */
            response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
    return response;
}

/**
 * Permite obtener los usuarios del sistema por id
 * @param {Number} id id del usuario
 * @returns Lista de paises
 */
async getbyId(id, id_business, is_super_admin = false) {
    let response;        
    try {
        let result = await sequelize.query(SequelizeSP.SP_USER_LIST, {
            replacements: {
                _id : id,
                _id_business : id_business,
                _is_super_admin : is_super_admin ? 1 : 0
            },
            type: QueryTypes.RAW,
            plain: true
        });

        if(result && result[0]){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success((await addUserNames([result[0]], id_business, is_super_admin))[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{/* regresamos una excepción controlada al no obtener una respuesta */
            response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
    return response;
}

async getProfessionalProfile(idLogin, idBusiness, actorLogin = null, transaction = null) {
    try {
        if (actorLogin && actorLogin !== idLogin) {
            const canManageUsers = await this.hasPermission(actorLogin, 'admin.users', transaction);
            if (!canManageUsers) {
                return responseData.unauthorized('No tienes permiso para consultar este perfil profesional.');
            }
        }

        const result = await sequelize.query(
            `SELECT
                dpp.*,
                l.name AS user_name,
                l.email AS user_email,
                l.telephone AS user_phone,
                r.code AS rol
             FROM doctor_professional_profile dpp
             INNER JOIN login l ON l.id_login COLLATE utf8mb4_unicode_ci = dpp.id_login COLLATE utf8mb4_unicode_ci
             INNER JOIN rol r ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci
             WHERE dpp.id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
               AND dpp.id_business COLLATE utf8mb4_unicode_ci = :_id_business COLLATE utf8mb4_unicode_ci
             LIMIT 1`,
            {
                replacements: {
                    _id_login: idLogin,
                    _id_business: idBusiness
                },
                transaction, type: QueryTypes.SELECT
            }
        );

        return responseData.success(result[0] || null, Messages.DATA_GET_SUCCESSFULLY);
    } catch (error) {
        return SequelizeException(error, Messages.DATA_GET_ERROR);
    }
}

async saveProfessionalProfile(body) {
    let transaction = null, uploaded, previousSignature, committed = false, commitAttempted = false;
    try {
        const targetLogin = body.target_id_login || body.id_user || body.id_login;
        if (!targetLogin || !body.id_business) {
            return responseData.bad_request('Usuario y negocio requeridos para guardar perfil profesional.');
        }

        const canManageUsers = await this.hasPermission(body.id_login, 'admin.users');
        if (body.id_login !== targetLogin && !canManageUsers) {
            return responseData.unauthorized('No tienes permiso para editar este perfil profesional.');
        }

        const hasProfessionalPhone = Object.prototype.hasOwnProperty.call(body, 'professional_phone');
        const professionalPhone = validateProfessionalPhone(body.professional_phone);
        if(!professionalPhone.isValid) {
            return responseData.bad_request(professionalPhone.message, { fieldErrors: { professional_phone: professionalPhone.message } });
        }

        transaction = await beginLicenseMutation(sequelize, body.id_business);
        const user = await sequelize.query(
            `SELECT l.id_login, l.id_business, r.code AS rol
               FROM login l
               INNER JOIN rol r ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci
              WHERE l.id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND l.id_business COLLATE utf8mb4_unicode_ci = :_id_business COLLATE utf8mb4_unicode_ci
                AND l.active = 1
              LIMIT 1`,
            {
                replacements: {
                    _id_login: targetLogin,
                    _id_business: body.id_business
                },
                transaction, type: QueryTypes.SELECT
            }
        );

        if (!user || user.length === 0) {
            return responseData.bad_request('Usuario invalido para este negocio.');
        }

        const existing = await sequelize.query(
            `SELECT id_doctor_professional_profile
               FROM doctor_professional_profile
              WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND id_business COLLATE utf8mb4_unicode_ci = :_id_business COLLATE utf8mb4_unicode_ci
              LIMIT 1`,
            {
                replacements: {
                    _id_login: targetLogin,
                    _id_business: body.id_business
                },
                transaction, type: QueryTypes.SELECT
            }
        );

        const isSelfEdit = body.id_login === targetLogin;
        const preserveAdminControlledFlags = isSelfEdit && !canManageUsers;
        const currentProfile = existing[0]
            ? await sequelize.query(
                `SELECT can_issue_prescriptions, can_sign_documents, is_active,
                        professional_name, professional_license, university, specialty,
                        specialty_license, professional_phone, signature_image
                   FROM doctor_professional_profile
                  WHERE id_doctor_professional_profile COLLATE utf8mb4_unicode_ci = :_id_doctor_professional_profile COLLATE utf8mb4_unicode_ci
                  LIMIT 1`,
                {
                    replacements: { _id_doctor_professional_profile: existing[0].id_doctor_professional_profile },
                    transaction, type: QueryTypes.SELECT
                }
            )
            : [];
        const currentFlags = currentProfile[0] || {};
        const profileField = field => (body[field] === undefined ? currentFlags[field] : body[field]) || null;
        const currentProfileActive = existing[0] ? normalizeUpdateActive(currentFlags.is_active, true) : false;
        const nextProfileActive = preserveAdminControlledFlags
            ? (existing[0] ? currentProfileActive : true)
            : normalizeUpdateActive(body.is_active, true);

        if (nextProfileActive && !currentProfileActive) {
            const licenseValidation = await validateLicenseForProfessionalProfile(body.id_business, targetLogin, body.id_login || null, transaction);
            if (licenseValidation && licenseValidation.allowed === false) {
                await transaction.commit(); transaction = null;
                return licenseValidation.response;
            }
            if (licenseValidation && licenseValidation.status) {
                return licenseValidation;
            }
        }

        previousSignature = currentFlags.signature_image;
        let signature = profileField('signature_image');
        if (signature !== (previousSignature || null)) {
            if (signature && !String(signature).startsWith('data:image/')) return responseData.bad_request('Captura una firma nueva o conserva la firma actual.');
            if (signature) {
                const validation = require('../../services/documentSignature/signatureImage.service').validateSignatureImage(signature);
                if (validation.error) return validation.error;
                uploaded = await privateImages.upload(validation.image, body.id_business, targetLogin);
                signature = uploaded.Key;
            }
        }
        const replacements = {
            _id_doctor_professional_profile: existing[0] ? existing[0].id_doctor_professional_profile : uuidv4(),
            _id_business: body.id_business,
            _id_login: targetLogin,
            _professional_name: profileField('professional_name'),
            _professional_license: profileField('professional_license'),
            _university: profileField('university'),
            _specialty: profileField('specialty'),
            _specialty_license: profileField('specialty_license'),
            _professional_phone: hasProfessionalPhone ? professionalPhone.value || null : currentFlags.professional_phone || null,
            _signature_image: signature,
            _can_issue_prescriptions: preserveAdminControlledFlags ? (currentFlags.can_issue_prescriptions || 0) : (body.can_issue_prescriptions === false ? 0 : 1),
            _can_sign_documents: preserveAdminControlledFlags ? (currentFlags.can_sign_documents || 0) : (body.can_sign_documents === true ? 1 : 0),
            _is_active: preserveAdminControlledFlags ? (existing[0] ? (currentProfileActive ? 1 : 0) : 1) : (nextProfileActive ? 1 : 0),
            _updated_by: body.id_login || null
        };

        if (existing[0]) {
            await sequelize.query(
                `UPDATE doctor_professional_profile
                    SET professional_name = :_professional_name,
                        professional_license = :_professional_license,
                        university = :_university,
                        specialty = :_specialty,
                        specialty_license = :_specialty_license,
                        professional_phone = :_professional_phone,
                        signature_image = :_signature_image,
                        can_issue_prescriptions = :_can_issue_prescriptions,
                        can_sign_documents = :_can_sign_documents,
                        is_active = :_is_active,
                        updated_at = NOW(),
                        updated_by = :_updated_by
                  WHERE id_doctor_professional_profile COLLATE utf8mb4_unicode_ci = :_id_doctor_professional_profile COLLATE utf8mb4_unicode_ci`,
                { replacements, transaction, type: QueryTypes.UPDATE }
            );
        } else {
            await sequelize.query(
                `INSERT INTO doctor_professional_profile (
                    id_doctor_professional_profile, id_business, id_login, professional_name,
                    professional_license, university, specialty, specialty_license,
                    professional_phone, signature_image, can_issue_prescriptions,
                    can_sign_documents, is_active, created_at, created_by
                ) VALUES (
                    :_id_doctor_professional_profile, :_id_business, :_id_login, :_professional_name,
                    :_professional_license, :_university, :_specialty, :_specialty_license,
                    :_professional_phone, :_signature_image, :_can_issue_prescriptions,
                    :_can_sign_documents, :_is_active, NOW(), :_updated_by
                )`,
                { replacements, transaction, type: QueryTypes.INSERT }
            );
        }

        await seedDashboardPermissions(body.id_business, targetLogin, transaction);

        await seedTracingPermissions(body.id_business, targetLogin, transaction);
        const result = await this.getProfessionalProfile(targetLogin, body.id_business, body.id_login, transaction);
        if (result.status !== 200) return result;
        commitAttempted = true;
        await transaction.commit();
        transaction = null; committed = true;
        if (previousSignature !== signature) await privateImages.remove(previousSignature, body.id_business);
        return result;
    } catch (error) {
        return SequelizeException(error, Messages.DATA_SAVE_ERROR);
    } finally {
        if (transaction && !transaction.finished) await transaction.rollback();
        if (uploaded && !committed) {
            if (commitAttempted) await privateImages.pending(uploaded);
            else await privateImages.remove(uploaded.Key, body.id_business);
        }
    }
}

async hasPermission(idLogin, permission, transaction = null) {
        return effectivePermissions.hasPermission(idLogin, permission, {enabledCatalog:false, transaction});
    }


}

module.exports = new UserDao;

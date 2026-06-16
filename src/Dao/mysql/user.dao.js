const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');
const { encript } = require('../../util/bcrypt')
const {v4: uuidv4 } = require('uuid');
const LicenseUsageDao = require('./licenseUsage.dao');
const {
    classifyLicenseResource,
    validateLicenseForNewUser,
    validateLicenseForProfessionalProfile,
    validateLicenseTransition
} = require('../../util/licenseLimits');

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

/**
 * Clase principal
 */
class UserDao{

/**
 * Permite registrar un nuevo usuario
 * @returns Lista de paises
 */
 async saveUser(body) {
    let response;        
    try {
        const existingUser = await sequelize.query(
            'SELECT id_login FROM login WHERE (telephone = :_telephone OR email = :_email) AND active = 1 LIMIT 1',
            {
                replacements: {
                    _telephone: body.phone,
                    _email: body.email
                },
                type: QueryTypes.SELECT
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
                type: QueryTypes.SELECT
            }
        );

        if (!role || role.length === 0) {
            return responseData.bad_request('Id rol invalido.');
        }

        const licenseValidation = await validateLicenseForNewUser(body.id_business, role[0], body.id_login || null);
        if (licenseValidation && licenseValidation.allowed === false) {
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
                    _name: body.name,
                    _email: body.email,
                    _telephone: body.phone,
                    _password: pwd,
                    _created_by: body.id_login || null,
                    _id_business: body.id_business || null
                },
                type: QueryTypes.INSERT
            }
        );

        let result = await sequelize.query(
            `SELECT
                l.id_login,
                l.id_rol,
                l.name,
                l.email,
                l.telephone AS phone,
                l.active
             FROM login l
             WHERE l.id_login = :_id_login`,
            {
                replacements: {
                    _id_login: idLogin
                },
                type: QueryTypes.SELECT
            }
        );

        response = responseData.success(result[0], Messages.DATA_SAVE_SUCCESSFULLY);
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
    return response;
}

/**
 * Permite registrar un nuevo usuario usando el SP legado.
 * Se conserva por referencia mientras migramos a SQL directo.
 */
 async saveUserLegacy(body) {
    let response;
    try {
        let pwd = await encript(body.password);
        let result = await sequelize.query(SequelizeSP.SP_USER_SAVE, {
            replacements: {
                _id_rol : body.id_rol,
                _name : body.name,
                _email : body.email,
                _telephone : body.phone,
                _password : pwd,
                _id_business : body.id_business || null
            },
            type: QueryTypes.RAW,
            plain: true
        });

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_SAVE_SUCCESSFULLY) : responseData.notSuccess(SQLValid.message);
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
 * Permite actualizar un usuario especifico
 * @param {any} body Payload
 * @param {String} id_login id del usuario a modificar
 * @returns 
 */
async updateUser(body,id_login) {
    let response;        
    try {
        const currentState = await LicenseUsageDao.getLicenseUserState(body.is_super_admin ? null : body.id_business, id_login);
        if (!currentState) {
            return responseData.bad_request('Usuario invalido para este negocio.');
        }

        const nextRoleId = pickValue(body.id_rol, currentState.id_rol);
        const nextRole = nextRoleId === currentState.id_rol
            ? { id_rol: currentState.id_rol, code: currentState.roleCode }
            : await LicenseUsageDao.getRoleById(nextRoleId);

        if (!nextRole || !nextRole.code) {
            return responseData.bad_request('Id rol invalido.');
        }

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
            idBusiness: targetBusiness,
            targetLoginId: id_login,
            currentResource,
            nextResource,
            actorLoginId: body.id_login || null,
            roleCode: nextRole.code,
            action: 'user_update'
        });

        if (licenseValidation && licenseValidation.allowed === false) {
            return licenseValidation.response;
        }
        if (licenseValidation && licenseValidation.status) {
            return licenseValidation;
        }

        let result = await sequelize.query(SequelizeSP.SP_USER_UPDATE, {
            replacements: {
                _id_login : id_login,
                _id_rol : nextRoleId,
                _name : pickValue(body.name, currentState.name),
                _email : pickValue(body.email, currentState.email),
                _telephone : pickValue(body.phone || body.telephone, currentState.telephone),
                _active : nextActive ? 1 : 0,
                _id_business : targetBusiness,
                _is_super_admin : body.is_super_admin ? 1 : 0
            },
            type: QueryTypes.RAW,
            plain: true
        });

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_SAVE_SUCCESSFULLY) : responseData.notSuccess(SQLValid.message);
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
            response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
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

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{/* regresamos una excepción controlada al no obtener una respuesta */
            response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
    return response;
}

async getProfessionalProfile(idLogin, idBusiness, actorLogin = null) {
    try {
        if (actorLogin && actorLogin !== idLogin) {
            const canManageUsers = await this.hasPermission(actorLogin, 'admin.users');
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
                type: QueryTypes.SELECT
            }
        );

        return responseData.success(result[0] || null, Messages.DATA_GET_SUCCESSFULLY);
    } catch (error) {
        return SequelizeException(error, Messages.DATA_GET_ERROR);
    }
}

async saveProfessionalProfile(body) {
    try {
        const targetLogin = body.target_id_login || body.id_user || body.id_login;
        if (!targetLogin || !body.id_business) {
            return responseData.bad_request('Usuario y negocio requeridos para guardar perfil profesional.');
        }

        if (body.id_login !== targetLogin) {
            const canManageUsers = await this.hasPermission(body.id_login, 'admin.users');
            if (!canManageUsers) {
                return responseData.unauthorized('No tienes permiso para editar este perfil profesional.');
            }
        }

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
                type: QueryTypes.SELECT
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
                type: QueryTypes.SELECT
            }
        );

        const isSelfEdit = body.id_login === targetLogin;
        const currentProfile = existing[0]
            ? await sequelize.query(
                `SELECT can_issue_prescriptions, can_sign_documents, is_active
                   FROM doctor_professional_profile
                  WHERE id_doctor_professional_profile COLLATE utf8mb4_unicode_ci = :_id_doctor_professional_profile COLLATE utf8mb4_unicode_ci
                  LIMIT 1`,
                {
                    replacements: { _id_doctor_professional_profile: existing[0].id_doctor_professional_profile },
                    type: QueryTypes.SELECT
                }
            )
            : [];
        const currentFlags = currentProfile[0] || {};
        const currentProfileActive = existing[0] ? normalizeUpdateActive(currentFlags.is_active, true) : false;
        const nextProfileActive = isSelfEdit
            ? (existing[0] ? currentProfileActive : true)
            : normalizeUpdateActive(body.is_active, true);

        if (nextProfileActive && !currentProfileActive) {
            const licenseValidation = await validateLicenseForProfessionalProfile(body.id_business, targetLogin, body.id_login || null);
            if (licenseValidation && licenseValidation.allowed === false) {
                return licenseValidation.response;
            }
            if (licenseValidation && licenseValidation.status) {
                return licenseValidation;
            }
        }

        const replacements = {
            _id_doctor_professional_profile: existing[0] ? existing[0].id_doctor_professional_profile : uuidv4(),
            _id_business: body.id_business,
            _id_login: targetLogin,
            _professional_name: body.professional_name || null,
            _professional_license: body.professional_license || null,
            _university: body.university || null,
            _specialty: body.specialty || null,
            _specialty_license: body.specialty_license || null,
            _professional_phone: body.professional_phone || null,
            _signature_image: body.signature_image || null,
            _can_issue_prescriptions: isSelfEdit ? (currentFlags.can_issue_prescriptions || 0) : (body.can_issue_prescriptions === false ? 0 : 1),
            _can_sign_documents: isSelfEdit ? (currentFlags.can_sign_documents || 0) : (body.can_sign_documents === true ? 1 : 0),
            _is_active: isSelfEdit ? (existing[0] ? (currentProfileActive ? 1 : 0) : 1) : (nextProfileActive ? 1 : 0),
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
                { replacements, type: QueryTypes.UPDATE }
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
                { replacements, type: QueryTypes.INSERT }
            );
        }

        return this.getProfessionalProfile(targetLogin, body.id_business, body.id_login);
    } catch (error) {
        return SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
}

async hasPermission(idLogin, permission) {
    if (!idLogin) {
        return false;
    }

    const result = await sequelize.query(
        `SELECT 1
           FROM login l
           INNER JOIN permission_rol pr ON pr.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci AND pr.active = 1
           INNER JOIN cat_permission cp ON cp.id_cat_permission COLLATE utf8mb4_unicode_ci = pr.id_cat_permission COLLATE utf8mb4_unicode_ci
          WHERE l.id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
            AND l.active = 1
            AND cp.code COLLATE utf8mb4_unicode_ci = :_permission COLLATE utf8mb4_unicode_ci
            AND cp.active = 1
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


}

module.exports = new UserDao;

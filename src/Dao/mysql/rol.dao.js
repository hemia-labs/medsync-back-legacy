const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');
const AdminAuditDao = require('./adminAudit.dao');
const { isTenantAdministrator, ADMIN_ROLES } = require('../../util/effectivePermissions');
const { getBusinessEffectiveLicense } = require('../../util/licenseLimits');
const {
    getPermissionLicensingRule,
    getForbiddenPermissionsForPlan,
    diffPermissions
} = require('../../util/permissionLicensing');

const PLAN_FEATURE_NOT_ALLOWED = 'PLAN_FEATURE_NOT_ALLOWED';
const ROLE_PERMISSIONS_UPDATE = 'ROLE_PERMISSIONS_UPDATE';
const ROLE_PERMISSIONS_BLOCKED = 'ROLE_PERMISSIONS_BLOCKED';
const FORBIDDEN_STATUS = 403;
const TENANT_FORBIDDEN_ROLE_CODES = ['super_admin'];

function normalizePermissionCode(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizePermissionList(permissions) {
    const seen = {};
    return (Array.isArray(permissions) ? permissions : [])
        .map(normalizePermissionCode)
        .filter((code) => {
            if (!code || seen[code]) {
                return false;
            }
            seen[code] = true;
            return true;
        });
}

function uniqueCodes(permissionCodes) {
    const seen = {};
    return (Array.isArray(permissionCodes) ? permissionCodes : [])
        .map(normalizePermissionCode)
        .filter((code) => {
            if (!code || seen[code]) {
                return false;
            }
            seen[code] = true;
            return true;
        });
}

function buildPermissionAuditMetadata({ context, idRol, role, planCode, addedPermissions, removedPermissions, premiumPermissionsRequested, forbiddenPermissions, reason }) {
    return {
        business_id: context.idBusiness || null,
        role_id: idRol,
        role_code: role.code || null,
        plan: planCode,
        added_permissions: uniqueCodes(addedPermissions),
        removed_permissions: uniqueCodes(removedPermissions),
        premium_permissions_requested: uniqueCodes(premiumPermissionsRequested),
        forbidden_permissions: uniqueCodes(forbiddenPermissions),
        reason
    };
}

function forbiddenPlanResponse({ planCode, role, forbiddenPermissions, premiumPermissionsRequested }) {
    const firstPermission = forbiddenPermissions[0] || null;
    const firstRule = firstPermission ? getPermissionLicensingRule(firstPermission) : null;
    return {
        status: FORBIDDEN_STATUS,
        data: {
            code: PLAN_FEATURE_NOT_ALLOWED,
            feature: 'roles_permissions',
            details: {
                plan: planCode || null,
                requiredPlan: firstRule ? firstRule.minimumPlan : null,
                role_id: role ? role.id_rol : null,
                role_code: role ? role.code : null,
                forbidden_permissions: forbiddenPermissions,
                premium_permissions_requested: premiumPermissionsRequested || []
            }
        },
        message: 'Este permiso no esta incluido en tu plan actual.'
    };
}

function isForbiddenTenantRole(role) {
    const code = normalizePermissionCode(role && role.code);
    return TENANT_FORBIDDEN_ROLE_CODES.includes(code) || code.indexOf('platform.') === 0;
}

function isPlatformPermission(permissionCode) {
    const code = normalizePermissionCode(permissionCode);
    return code.indexOf('super_admin') === 0 || code.indexOf('platform.') === 0;
}

function mapPermissionLicensing(permission, planCode) {
    const rule = getPermissionLicensingRule(permission.code);
    const forbidden = getForbiddenPermissionsForPlan([permission.code], planCode).length > 0;
    return {
        ...permission,
        licensing: {
            category: rule.category,
            minimumPlan: rule.minimumPlan,
            isPremium: rule.isPremium === true,
            isSuperAdminOnly: rule.isSuperAdminOnly === true,
            canBlockByPlan: rule.canBlockByPlan === true,
            planAllowed: !forbidden,
            canAdd: !forbidden,
            blockedReason: forbidden ? 'Este permiso no esta incluido en tu plan actual.' : null
        }
    };
}

async function getRoleById(idRol, transaction = null) {
    const rows = await sequelize.query(
        `SELECT id_rol, desc_rol, code, active
           FROM rol
          WHERE id_rol = :_id_rol
            AND active = 1
          LIMIT 1`,
        {
            replacements: { _id_rol: idRol },
            type: QueryTypes.SELECT,
            transaction
        }
    );

    return rows && rows[0] ? rows[0] : null;
}

async function getBusinessPlanCode(idBusiness) {
    if (!idBusiness) {
        return 'basic';
    }

    const license = await getBusinessEffectiveLicense(idBusiness);
    return license && license.plan && license.plan.code ? license.plan.code : 'basic';
}

async function getCurrentRolePermissionCodes(idRol, idBusiness, transaction = null) {
    const rows = await sequelize.query(
        `SELECT cp.code
           FROM cat_permission cp
           LEFT JOIN permission_rol pr ON pr.id_cat_permission = cp.id_cat_permission AND pr.id_rol = :_id_rol
           LEFT JOIN business_role_permission bp ON bp.id_cat_permission = cp.id_cat_permission
                AND bp.id_rol = :_id_rol AND bp.id_business = :_id_business
          WHERE cp.active = 1 AND COALESCE(bp.active, pr.active, 0) = 1`,
        {
            replacements: { _id_rol: idRol, _id_business:idBusiness },
            type: QueryTypes.SELECT,
            transaction
        }
    );

    return rows.map((row) => normalizePermissionCode(row.code));
}

/**
 * Clase principal
 */
class RolDao{

/**
 * Permite obtener la lista de roles
 * @returns Lista de paises
 */
async getRoles(isSuperAdmin = false) {
    let response;        
    try {
        let result = await sequelize.query(
            `SELECT id_rol, desc_rol, code, active
               FROM rol
              WHERE active = 1
                AND (:_is_super_admin = 1 OR code <> 'super_admin')
              ORDER BY desc_rol ASC`,
            {
                replacements: { _is_super_admin: isSuperAdmin ? 1 : 0 },
                type: QueryTypes.SELECT
            }
        );

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

async getPermissions(idRol, context = {}) {
    let response;

    try {
        if (!(await isTenantAdministrator(context.actorLoginId, context.idBusiness, 'admin.users'))) return responseData.forbidden('Solo el administrador autorizado del consultorio puede consultar accesos.');
        const role = await getRoleById(idRol);
        if (!role || isForbiddenTenantRole(role)) {
            return responseData.notSuccess('Rol no encontrado.');
        }

        const planCode = await getBusinessPlanCode(context.idBusiness);
        let result = await sequelize.query(
            `SELECT
                cp.id_cat_permission,
                cp.code,
                cp.name,
                cp.description,
                cp.value AS module,
                cp.sec,
                COALESCE(bp.active, pr.active, 0) AS allowed
             FROM cat_permission cp
             LEFT JOIN permission_rol pr
               ON pr.id_cat_permission = cp.id_cat_permission
              AND pr.id_rol = :_id_rol
             LEFT JOIN business_role_permission bp
               ON bp.id_cat_permission = cp.id_cat_permission
              AND bp.id_rol = :_id_rol AND bp.id_business = :_id_business
             WHERE cp.active = 1
             ORDER BY cp.value ASC, cp.sec ASC, cp.name ASC`,
            {
                replacements: { _id_rol: idRol, _id_business:context.idBusiness },
                type: QueryTypes.SELECT
            }
        );

        response = responseData.success(
            result
                .filter((permission) => !isPlatformPermission(permission.code))
                .map((permission) => mapPermissionLicensing(permission, planCode)),
            Messages.DATA_GET_SUCCESSFULLY
        );
    } catch (error) {
        response = SequelizeException(error, Messages.DATA_GET_ERROR);
    }

    return response;
}

async savePermissions(idRol, permissions, context = {}) {
    let response;

    try {
        if (!(await isTenantAdministrator(context.actorLoginId, context.idBusiness, 'admin.users'))) return responseData.forbidden('Solo el administrador autorizado del consultorio puede modificar accesos.');
        if (!Array.isArray(permissions)) return responseData.bad_request('Envia la lista de permisos del puesto.');
        const role = await getRoleById(idRol);
        if (!role || isForbiddenTenantRole(role)) {
            return forbiddenPlanResponse({
                planCode: null,
                role,
                forbiddenPermissions: ['super_admin'],
                premiumPermissionsRequested: ['super_admin']
            });
        }

        const planCode = await getBusinessPlanCode(context.idBusiness);
        const rawRequestedCodes = normalizePermissionList(permissions);
        const adminRole = ADMIN_ROLES.includes(normalizePermissionCode(role.code));
        if (!adminRole && rawRequestedCodes.some(code => code === 'admin.config' || code === 'admin.users')) return responseData.forbidden('La administracion del consultorio se reserva al puesto administrador.');
        if (adminRole && !['admin.config','admin.users'].every(code => rawRequestedCodes.includes(code))) return responseData.forbidden('El puesto administrador debe conservar los accesos a configuracion y personal.');
        const forbiddenPlatformCodes = rawRequestedCodes.filter((code) => isPlatformPermission(code));
        const selectedCodes = rawRequestedCodes.filter((code) => !isPlatformPermission(code));
        const allPermissions = await sequelize.query(
            'SELECT id_cat_permission, code FROM cat_permission WHERE active = 1',
            {
                replacements: {},
                type: QueryTypes.SELECT
            }
        );
        const allowedCatalogCodes = new Set(allPermissions.map((permission) => normalizePermissionCode(permission.code)));
        const requestedCodes = selectedCodes.filter((code) => allowedCatalogCodes.has(code));
        const currentCodes = await getCurrentRolePermissionCodes(idRol, context.idBusiness);
        const diff = diffPermissions(currentCodes, requestedCodes, planCode);
        const forbiddenPermissions = uniqueCodes(diff.forbidden_permissions.concat(forbiddenPlatformCodes));
        const premiumPermissionsRequested = uniqueCodes(diff.premium_permissions_requested.concat(
            forbiddenPlatformCodes.filter((code) => getPermissionLicensingRule(code).isPremium === true)
        ));
        const addedPermissions = uniqueCodes(diff.permissions_to_add.concat(forbiddenPlatformCodes));

        if (forbiddenPermissions.length) {
            await AdminAuditDao.record(ROLE_PERMISSIONS_BLOCKED, {
                actor_login_id: context.actorLoginId || null,
                actor_role: context.actorRole || 'tenant_user',
                target_type: 'role',
                target_id: idRol,
                target_business_id: context.idBusiness || null,
                ip: context.ip || null,
                user_agent: context.userAgent || null,
                metadata: buildPermissionAuditMetadata({
                    context,
                    idRol,
                    role,
                    planCode,
                    addedPermissions,
                    removedPermissions: diff.permissions_to_remove,
                    premiumPermissionsRequested,
                    forbiddenPermissions,
                    reason: 'plan_permission_not_allowed'
                })
            });

            return forbiddenPlanResponse({
                planCode,
                role,
                forbiddenPermissions,
                premiumPermissionsRequested
            });
        }

        const selected = new Set(requestedCodes);

        await sequelize.transaction(async (transaction) => {
            // Serialize edits within a consultorio; never mutate the shared defaults.
            await sequelize.query('SELECT id_business FROM business WHERE id_business = :_id_business FOR UPDATE', {
                replacements:{_id_business:context.idBusiness},type:QueryTypes.SELECT,transaction
            });
            for (const permission of allPermissions) {
                if (isPlatformPermission(permission.code)) continue;
                await sequelize.query(`INSERT INTO business_role_permission
                    (id_business,id_rol,id_cat_permission,active,updated_by)
                    VALUES (:_id_business,:_id_rol,:_id_cat_permission,:_active,:_actor)
                    ON DUPLICATE KEY UPDATE active=VALUES(active),updated_by=VALUES(updated_by),updated_at=NOW()`, {
                    replacements:{_id_business:context.idBusiness,_id_rol:idRol,_id_cat_permission:permission.id_cat_permission,
                        _active:selected.has(normalizePermissionCode(permission.code)) ? 1 : 0,_actor:context.actorLoginId},
                    type:QueryTypes.INSERT,transaction
                });
            }
        });

        await AdminAuditDao.record(ROLE_PERMISSIONS_UPDATE, {
            actor_login_id: context.actorLoginId || null,
            actor_role: context.actorRole || 'tenant_user',
            target_type: 'role',
            target_id: idRol,
            target_business_id: context.idBusiness || null,
            ip: context.ip || null,
            user_agent: context.userAgent || null,
            metadata: buildPermissionAuditMetadata({
                context,
                idRol,
                role,
                planCode,
                addedPermissions: diff.permissions_to_add,
                removedPermissions: diff.permissions_to_remove,
                premiumPermissionsRequested,
                forbiddenPermissions: [],
                reason: 'role_permissions_update'
            })
        });

        response = await this.getPermissions(idRol, context);
    } catch (error) {
        response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }

    return response;
}

}

module.exports = new RolDao;

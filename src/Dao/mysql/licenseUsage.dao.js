const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const PROFESSIONAL_ROLE_CODES = ['doctor', 'dentist', 'odontologist', 'specialist', 'professional', 'medico', 'odontologo', 'especialista'];
const AUXILIARY_ROLE_CODES = ['admin', 'business_admin', 'assistant', 'reception', 'receptionist', 'auxiliary', 'staff', 'admin_staff', 'auxiliar', 'recepcion', 'asistente', 'administracion'];
const IGNORED_ROLE_CODES = ['super_admin'];
const PROFESSIONAL_ROLE_SQL = PROFESSIONAL_ROLE_CODES.map((code) => `'${code}'`).join(', ');
const IGNORED_ROLE_SQL = IGNORED_ROLE_CODES.map((code) => `'${code}'`).join(', ');

async function getRoleById(idRole, transaction = null) {
    if (!idRole) {
        return null;
    }

    const rows = await sequelize.query(
        `SELECT id_rol, code, desc_rol, active
           FROM rol
          WHERE id_rol COLLATE ${TENANT_COLLATION} = :_id_rol COLLATE ${TENANT_COLLATION}
            AND active = 1
          LIMIT 1`,
        {
            replacements: {
                _id_rol: idRole
            },
            type: QueryTypes.SELECT, transaction
        }
    );

    return rows[0] || null;
}

async function getBusinessPlan(idBusiness, transaction = null) {
    if (!idBusiness) {
        return null;
    }

    const rows = await sequelize.query(
        `SELECT id_business, name, plan, subscription_status, active, status
           FROM business
          WHERE id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}
          LIMIT 1`,
        {
            replacements: {
                _id_business: idBusiness
            },
            type: QueryTypes.SELECT, transaction
        }
    );

    return rows[0] || null;
}

async function getBusinessLicenseUsage(idBusiness, transaction = null) {
    const rows = await sequelize.query(
        `SELECT
            COUNT(DISTINCT CASE
                WHEN l.active = 1
                 AND LOWER(COALESCE(r.code, '')) NOT IN (${IGNORED_ROLE_SQL})
                 AND (
                    LOWER(COALESCE(r.code, '')) IN (${PROFESSIONAL_ROLE_SQL})
                    OR dpp.id_doctor_professional_profile IS NOT NULL
                 )
                THEN l.id_login
            END) AS professionals,
            COUNT(DISTINCT CASE
                WHEN l.active = 1
                 AND LOWER(COALESCE(r.code, '')) NOT IN (${IGNORED_ROLE_SQL})
                 AND NOT (
                    LOWER(COALESCE(r.code, '')) IN (${PROFESSIONAL_ROLE_SQL})
                    OR dpp.id_doctor_professional_profile IS NOT NULL
                 )
                THEN l.id_login
            END) AS auxiliaryUsers
           FROM login l
           LEFT JOIN rol r
                  ON r.id_rol COLLATE ${TENANT_COLLATION} = l.id_rol COLLATE ${TENANT_COLLATION}
           LEFT JOIN doctor_professional_profile dpp
                  ON dpp.id_login COLLATE ${TENANT_COLLATION} = l.id_login COLLATE ${TENANT_COLLATION}
                 AND dpp.id_business COLLATE ${TENANT_COLLATION} = l.id_business COLLATE ${TENANT_COLLATION}
                 AND COALESCE(dpp.is_active, 1) = 1
          WHERE l.id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}`,
        {
            replacements: {
                _id_business: idBusiness
            },
            type: QueryTypes.SELECT, transaction
        }
    );

    const row = rows[0] || {};

    return {
        professionals: Number(row.professionals || 0),
        auxiliaryUsers: Number(row.auxiliaryUsers || 0),
        staffUsers: Number(row.auxiliaryUsers || 0),
        // Placeholder interno por compatibilidad. No representa multi-sucursal ni feature comercial.
        branches: 1
    };
}

function mapOverride(row) {
    const expired = Boolean(row && row.valid_until && new Date(row.valid_until) < new Date());

    return {
        id: row && row.id ? row.id : null,
        id_business: row && row.id_business ? row.id_business : null,
        extra_professionals: Number(row && row.extra_professionals ? row.extra_professionals : 0),
        extra_auxiliary_users: Number(row && row.extra_auxiliary_users ? row.extra_auxiliary_users : 0),
        extra_branches: Number(row && row.extra_branches ? row.extra_branches : 0),
        reason: row && row.reason ? row.reason : null,
        valid_until: row && row.valid_until ? row.valid_until : null,
        expired,
        created_at: row && row.created_at ? row.created_at : null,
        updated_at: row && row.updated_at ? row.updated_at : null
    };
}

async function getBusinessLicenseOverride(idBusiness, options = {}) {
    if (!idBusiness) {
        return mapOverride(null);
    }

    const rows = await sequelize.query(
        `SELECT
            id,
            id_business,
            extra_professionals,
            extra_auxiliary_users,
            extra_branches,
            reason,
            valid_until,
            created_at,
            updated_at
           FROM business_license_overrides
          WHERE id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}
          LIMIT 1 ${options.forUpdate ? 'FOR UPDATE' : ''}`,
        {
            replacements: {
                _id_business: idBusiness
            },
            type: QueryTypes.SELECT,
            transaction: options.transaction
        }
    );

    return mapOverride(rows[0] || null);
}

async function hasActiveProfessionalProfile(idBusiness, idLogin, transaction = null) {
    if (!idBusiness || !idLogin) {
        return false;
    }

    const rows = await sequelize.query(
        `SELECT id_doctor_professional_profile
           FROM doctor_professional_profile
          WHERE id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION}
            AND id_login COLLATE ${TENANT_COLLATION} = :_id_login COLLATE ${TENANT_COLLATION}
            AND COALESCE(is_active, 1) = 1
          LIMIT 1`,
        {
            replacements: {
                _id_business: idBusiness,
                _id_login: idLogin
            },
            type: QueryTypes.SELECT, transaction
        }
    );

    return rows.length > 0;
}

async function getLicenseUserState(idBusiness, idLogin, transaction = null) {
    if (!idLogin) {
        return null;
    }

    const rows = await sequelize.query(
        `SELECT
            l.id_login,
            l.id_business,
            l.id_rol,
            l.name,
            l.first_name,
            l.last_name,
            l.email,
            l.telephone,
            l.active,
            r.code AS roleCode,
            CASE WHEN dpp.id_doctor_professional_profile IS NULL THEN 0 ELSE 1 END AS hasActiveProfessionalProfile
           FROM login l
           LEFT JOIN rol r
                  ON r.id_rol COLLATE ${TENANT_COLLATION} = l.id_rol COLLATE ${TENANT_COLLATION}
           LEFT JOIN doctor_professional_profile dpp
                  ON dpp.id_login COLLATE ${TENANT_COLLATION} = l.id_login COLLATE ${TENANT_COLLATION}
                 AND dpp.id_business COLLATE ${TENANT_COLLATION} = l.id_business COLLATE ${TENANT_COLLATION}
                 AND COALESCE(dpp.is_active, 1) = 1
          WHERE l.id_login COLLATE ${TENANT_COLLATION} = :_id_login COLLATE ${TENANT_COLLATION}
            AND (:_id_business IS NULL OR l.id_business COLLATE ${TENANT_COLLATION} = :_id_business COLLATE ${TENANT_COLLATION})
          LIMIT 1`,
        {
            replacements: {
                _id_login: idLogin,
                _id_business: idBusiness || null
            },
            type: QueryTypes.SELECT, transaction
        }
    );

    return rows[0] || null;
}

module.exports = {
    PROFESSIONAL_ROLE_CODES,
    AUXILIARY_ROLE_CODES,
    IGNORED_ROLE_CODES,
    getRoleById,
    getBusinessPlan,
    getBusinessLicenseUsage,
    getBusinessLicenseOverride,
    hasActiveProfessionalProfile,
    getLicenseUserState
};

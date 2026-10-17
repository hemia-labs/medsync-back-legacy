const { QueryTypes } = require('sequelize');
const sequelize = require('../db/Sequelize.connection');

const eq = (a, b) => `${a} COLLATE utf8mb4_unicode_ci = ${b} COLLATE utf8mb4_unicode_ci`;
const ADMIN_ROLES = ['admin', 'business_admin'];

// The global catalog remains the default. Explicit tenant rows override grants
// and denials alike; an absent row inherits the catalog without copying data.
function joins() {
    return `INNER JOIN cat_permission cp ON cp.active = 1
        LEFT JOIN permission_rol pr ON ${eq('pr.id_rol', 'l.id_rol')}
            AND ${eq('pr.id_cat_permission', 'cp.id_cat_permission')}
        LEFT JOIN business_role_permission bp ON ${eq('bp.id_business', 'l.id_business')}
            AND ${eq('bp.id_rol', 'l.id_rol')}
            AND ${eq('bp.id_cat_permission', 'cp.id_cat_permission')}`;
}

async function rows(idLogin, options = {}) {
    if (!idLogin) return [];
    return sequelize.query(`SELECT ${options.permission || options.admin ? '1' : 'cp.code'}
        FROM login l ${options.admin ? `INNER JOIN rol r ON ${eq('r.id_rol', 'l.id_rol')} AND r.active = 1` : ''}
        ${joins()}
        WHERE ${eq('l.id_login', ':_id_login')} AND l.active = 1
          AND COALESCE(bp.active, pr.active, 0) = 1
          ${options.enabledCatalog ? 'AND cp.is_active = 1' : ''}
          ${options.permission ? `AND ${eq('cp.code', ':_permission')}` : ''}
          ${options.admin ? `AND ${eq('l.id_business', ':_id_business')} AND r.code IN ('admin', 'business_admin')` : ''}
        ${options.permission || options.admin ? 'LIMIT 1' : 'ORDER BY cp.value, cp.sec'}`, {
        replacements: {_id_login:idLogin,...(options.permission ? {_permission:options.permission} : {}),...(options.admin ? {_id_business:options.business} : {})},
        type: QueryTypes.SELECT, transaction:options.transaction || null
    });
}

async function hasPermission(idLogin, permission, options = {}) {
    if (!permission) return false;
    return (await rows(idLogin, {...options,permission})).length > 0;
}

async function isTenantAdministrator(idLogin, business, permission) {
    if (!business || !idLogin) return false;
    return hasPermission(idLogin, permission, {admin:true,business});
}

module.exports = { rows, hasPermission, isTenantAdministrator, ADMIN_ROLES };

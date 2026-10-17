const sequelize = require('../db/Sequelize.connection');

// Add only absent tenant defaults. Explicit grants/denials remain administrator decisions.
// The read permission is also required by the DAO on every call.
const seedSql = `INSERT IGNORE INTO business_role_permission (id_business, id_rol, id_cat_permission, active)
    SELECT DISTINCT l.id_business, l.id_rol, target.id_cat_permission, 1 FROM login l
    INNER JOIN rol r ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci AND r.active = 1 AND r.code <> 'super_admin'
    INNER JOIN cat_permission target ON target.code IN ('tracing.create', 'tracing.correct', 'tracing.cancel') AND target.active = 1
    INNER JOIN cat_permission cp ON cp.code = 'px.tab.monitoring' AND cp.active = 1
    LEFT JOIN permission_rol pr ON pr.id_rol = l.id_rol AND pr.id_cat_permission = cp.id_cat_permission
    LEFT JOIN business_role_permission bp ON bp.id_business = l.id_business AND bp.id_rol = l.id_rol AND bp.id_cat_permission = cp.id_cat_permission
    WHERE l.active = 1 AND l.id_business = :business AND (:login IS NULL OR l.id_login = :login)
      AND COALESCE(bp.active, pr.active, 0) = 1
      AND (EXISTS (SELECT 1 FROM doctor_professional_profile d WHERE d.id_login = l.id_login AND d.id_business = l.id_business AND d.is_active = 1)
        OR (target.code = 'tracing.create' AND EXISTS (SELECT 1 FROM cat_permission ch
            LEFT JOIN permission_rol chr ON chr.id_rol = l.id_rol AND chr.id_cat_permission = ch.id_cat_permission
            LEFT JOIN business_role_permission chb ON chb.id_business = l.id_business AND chb.id_rol = l.id_rol AND chb.id_cat_permission = ch.id_cat_permission
            WHERE ch.code = 'clinical_history.edit_draft' AND ch.active = 1 AND COALESCE(chb.active, chr.active, 0) = 1)))`;

async function seedTracingPermissions(business, login = null, transaction = null) {
    if (!business) return;
    return sequelize.query(seedSql, { replacements: { business, login }, transaction });
}

module.exports = { seedTracingPermissions, seedSql };

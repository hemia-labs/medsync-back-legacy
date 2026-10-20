const { QueryTypes } = require('sequelize');
const sequelize = require('../db/Sequelize.connection');
const effectivePermissions = require('./effectivePermissions');
const responseData = require('./responsedata');

const PERMISSIONS = Object.freeze({ administrative: 'dashboard.operations', clinical: 'dashboard.clinical', financial: 'dashboard.financial', all: 'dashboard.scope.all' });

async function resolveDashboardAccess(idBusiness, idLogin, options = {}) {
    if (!idBusiness || !idLogin) return { error: responseData.forbidden('Sesion de consultorio no disponible.') };
    const actors = await sequelize.query(`SELECT l.id_login, d.id_doctor_professional_profile, d.professional_name
        FROM login l LEFT JOIN doctor_professional_profile d ON d.id_login = l.id_login AND d.id_business = l.id_business AND d.is_active = 1
        WHERE l.id_login = :login AND l.id_business = :business AND l.active = 1 LIMIT 1`, {
        replacements: { login: idLogin, business: idBusiness }, type: QueryTypes.SELECT
    });
    if (!actors[0]) return { error: responseData.forbidden('Sesion de consultorio no disponible.') };
    // Home also needs legacy module grants (which do not require is_active).
    // Fetch both views once, scoped to this invocation; never cache across requests.
    const includePermissions = options.includePermissions === true;
    const permissionRows = await effectivePermissions.rows(idLogin, {
        enabledCatalog: !includePermissions, includeCatalogState: includePermissions
    });
    const codes = new Set(permissionRows.filter(row => !includePermissions || Number(row.is_active) === 1).map(row => row.code));
    const actor = actors[0];
    const doctorProfile = actor.id_doctor_professional_profile ? { id_doctor_professional_profile: actor.id_doctor_professional_profile, professional_name: actor.professional_name } : null;
    const canSelectTenant = codes.has(PERMISSIONS.all);
    const mode = options.scope || (doctorProfile ? 'own' : 'tenant');
    if (!['own', 'tenant'].includes(mode)) return { error: responseData.bad_request('Alcance de indicadores invalido.') };
    if (mode === 'own' && !doctorProfile) return { error: responseData.forbidden('El alcance propio requiere un perfil profesional activo.') };
    if (mode === 'tenant' && doctorProfile && !canSelectTenant) return { error: responseData.forbidden('No tienes permiso para consultar indicadores de todo el consultorio.') };
    const families = {
        administrative: codes.has(PERMISSIONS.administrative),
        clinical: codes.has(PERMISSIONS.clinical) && (mode === 'own' || canSelectTenant),
        financial: codes.has(PERMISSIONS.financial) && (mode === 'own' || canSelectTenant)
    };
    if (options.requireFamily !== false && !Object.values(families).some(Boolean)) return { error: responseData.forbidden('No tienes permisos para consultar estas familias de indicadores.') };
    return {
        ...(includePermissions ? { permissionCodes: new Set(permissionRows.map(row => row.code)) } : {}),
        families, doctorProfile, canSelectTenant, canSelectOwn: Boolean(doctorProfile),
        administrativeTeam: mode === 'tenant' && families.administrative && canSelectTenant,
        scope: { mode, doctorProfileId: mode === 'own' ? actor.id_doctor_professional_profile : null,
            idLogin: mode === 'own' ? idLogin : null, doctorName: mode === 'own' ? actor.professional_name : null,
            label: mode === 'own' ? 'Mi actividad' : 'Todo el consultorio' }
    };
}

// Tenant defaults only: preserve explicit grants and denials. Economic indicators
// and clinical intake always require a deliberate administrator grant.
const seedSql = `INSERT IGNORE INTO business_role_permission (id_business, id_rol, id_cat_permission, active)
    SELECT DISTINCT l.id_business, l.id_rol, target.id_cat_permission, 1 FROM login l
    JOIN rol r ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci AND r.active = 1 AND r.code <> 'super_admin'
    JOIN cat_permission target ON target.code IN ('dashboard.operations', 'dashboard.clinical', 'dashboard.scope.all') AND target.active = 1
    WHERE l.active = 1 AND l.id_business IS NOT NULL
      AND (:business IS NULL OR l.id_business = :business) AND (:login IS NULL OR l.id_login = :login)
      AND ((target.code = 'dashboard.operations' AND EXISTS (SELECT 1 FROM cat_permission cp
          LEFT JOIN permission_rol pr ON pr.id_rol = l.id_rol AND pr.id_cat_permission = cp.id_cat_permission
          LEFT JOIN business_role_permission bp ON bp.id_business = l.id_business AND bp.id_rol = l.id_rol AND bp.id_cat_permission = cp.id_cat_permission
          WHERE cp.code = 'px.dates' AND cp.active = 1 AND cp.is_active = 1 AND COALESCE(bp.active, pr.active, 0) = 1))
        OR (target.code = 'dashboard.clinical' AND EXISTS (SELECT 1 FROM doctor_professional_profile d WHERE d.id_login = l.id_login AND d.id_business = l.id_business AND d.is_active = 1)
          AND EXISTS (SELECT 1 FROM cat_permission cp
          LEFT JOIN permission_rol pr ON pr.id_rol = l.id_rol AND pr.id_cat_permission = cp.id_cat_permission
          LEFT JOIN business_role_permission bp ON bp.id_business = l.id_business AND bp.id_rol = l.id_rol AND bp.id_cat_permission = cp.id_cat_permission
          WHERE cp.code = 'clinical_history.view' AND cp.active = 1 AND cp.is_active = 1 AND COALESCE(bp.active, pr.active, 0) = 1))
        OR (target.code = 'dashboard.scope.all' AND r.code IN ('admin', 'business_admin')
          AND NOT EXISTS (SELECT 1 FROM doctor_professional_profile d JOIN login colleague ON colleague.id_login = d.id_login AND colleague.id_business = d.id_business
              WHERE colleague.id_rol = l.id_rol AND colleague.id_business = l.id_business AND colleague.active = 1 AND d.is_active = 1)))`;

async function seedDashboardPermissions(business, login = null, transaction = null) {
    if (!business) return;
    await sequelize.query(receptionSafetySql, { replacements: { business, login }, transaction });
    await sequelize.query(assistantTreatmentSql, { replacements: { business, login }, transaction });
    return sequelize.query(seedSql, { replacements: { business, login }, transaction });
}

// The historical reception role inherited full clinical draft access. Narrow only
// inherited defaults: deliberate tenant exceptions, including denials, survive.
const receptionSafetySql = `INSERT IGNORE INTO business_role_permission (id_business, id_rol, id_cat_permission, active)
    SELECT DISTINCT b.id_business, r.id_rol, target.id_cat_permission, 0 FROM business b
    JOIN rol r ON r.active = 1 AND r.code IN ('reception', 'receptionist')
    JOIN cat_permission target ON target.active = 1
    WHERE b.id_business IS NOT NULL
      AND (:business IS NULL OR b.id_business = :business)
      AND (:login IS NULL OR EXISTS (SELECT 1 FROM login l WHERE l.id_login = :login AND l.id_business = b.id_business AND l.active = 1))
      AND ((${['clinical_history.', 'prescriptions.', 'documents.', 'treatments.', 'tracing.', 'odontogram.'].map(prefix => `LEFT(target.code, LENGTH('${prefix}')) = '${prefix}'`).join(' OR ')})
        OR target.code IN ('px.tab.odontogram', 'px.tab.photos', 'px.tab.monitoring', 'px.tab.treatment', 'px.tab.prescriptions', 'px.photos.manager', 'px.radiography'))
      AND target.code <> 'clinical_history.intake'`;

const assistantTreatmentSql = `INSERT IGNORE INTO business_role_permission (id_business, id_rol, id_cat_permission, active)
    SELECT DISTINCT l.id_business, l.id_rol, target.id_cat_permission, 1 FROM login l
    JOIN rol r ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci AND r.active = 1 AND r.code = 'assistant'
    JOIN cat_permission target ON target.code = 'px.tab.treatment' AND target.active = 1
    JOIN cat_permission cp ON cp.code = 'treatments.view' AND cp.active = 1 AND cp.is_active = 1
    LEFT JOIN permission_rol pr ON pr.id_rol = l.id_rol AND pr.id_cat_permission = cp.id_cat_permission
    LEFT JOIN business_role_permission bp ON bp.id_business = l.id_business AND bp.id_rol = l.id_rol AND bp.id_cat_permission = cp.id_cat_permission
    WHERE l.active = 1 AND l.id_business IS NOT NULL AND COALESCE(bp.active, pr.active, 0) = 1
      AND (:business IS NULL OR l.id_business = :business) AND (:login IS NULL OR l.id_login = :login)`;

module.exports = { PERMISSIONS, resolveDashboardAccess, seedDashboardPermissions, seedSql, receptionSafetySql, assistantTreatmentSql };

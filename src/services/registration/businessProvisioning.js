'use strict';
const { QueryTypes } = require('sequelize');
const { randomUUID } = require('node:crypto');
const { seedDashboardPermissions } = require('../../util/dashboardAccess');
const { seedTracingPermissions } = require('../../util/tracingPermissions');

// Internal primitives only. Callers validate their own administrative/public
// contracts; every write uses the supplied transaction, never a nested commit.
class BusinessProvisioning {
    constructor(db) { this.db = db; }
    query(sql, replacements, transaction, type = QueryTypes.INSERT) {
        if (!transaction) throw new Error('PROVISIONING_TRANSACTION_REQUIRED');
        return this.db.query(sql, { replacements, transaction, type });
    }
    async business(values, transaction) {
        await this.query(`INSERT INTO business (id_business,name,legal_name,slug,email,phone,address,status,
            subscription_status,trial_starts_at,trial_ends_at,current_period_starts_at,current_period_ends_at,plan,active,created_at,created_by)
            VALUES (:_id_business,:_name,:_legal_name,:_slug,:_email,:_phone,:_address,:_status,:_subscription_status,
                CASE WHEN :_subscription_status = 'trial' THEN COALESCE(:_trial_starts_at,NOW()) ELSE NULL END,
                CASE WHEN :_subscription_status != 'trial' THEN NULL WHEN :_trial_ends_at IS NOT NULL THEN :_trial_ends_at
                    ELSE DATE_ADD(COALESCE(:_trial_starts_at,NOW()),INTERVAL :_trial_days DAY) END,
                CASE WHEN :_subscription_status = 'active' THEN NOW() ELSE NULL END,NULL,:_plan,:_active,NOW(),:_created_by)`, values, transaction);
    }
    async defaults(idBusiness, actor, transaction) {
        await this.query(`INSERT INTO appointment_config (id_appointment_config,id_business,enabled,default_appointment_duration,timezone,active,created_at,created_by)
            VALUES (:_id_appointment_config,:_id_business,1,30,'America/Mexico_City',1,NOW(),:_created_by)`,
        { _id_appointment_config: idBusiness+'-default', _id_business:idBusiness, _created_by:actor }, transaction);
        const themes = await this.query("SELECT id_cat_ui_theme FROM cat_ui_theme WHERE code='medical-blue' AND active=1 LIMIT 1", {}, transaction, QueryTypes.SELECT);
        if (themes.length) await this.query(`INSERT INTO ui_theme_configuration (id_ui_theme_configuration,id_business,id_cat_ui_theme,active,created_by,created_at)
            VALUES (:_id_ui_theme_configuration,:_id_business,:_id_cat_ui_theme,1,:_created_by,NOW())`,
        {_id_ui_theme_configuration:randomUUID(),_id_business:idBusiness,_id_cat_ui_theme:themes[0].id_cat_ui_theme,_created_by:actor},transaction);
        return { themeCreated: themes.length > 0 };
    }
    async administrator(values, transaction) {
        const names = { _first_name: values._first_name === undefined ? values._name : values._first_name, _last_name: values._last_name || '' };
        await this.query(`INSERT INTO login (id_login,id_business,id_rol,name,first_name,last_name,email,telephone,password,locked,active,created_at,created_by)
            VALUES (:_id_login,:_id_business,:_id_rol,:_name,:_first_name,:_last_name,:_email,:_telephone,:_password,0,1,NOW(),:_created_by)`, {...values,...names}, transaction);
        await seedDashboardPermissions(values._id_business, values._id_login, transaction, this.db);
        await seedTracingPermissions(values._id_business, values._id_login, transaction, this.db);
    }
}
module.exports = { BusinessProvisioning };

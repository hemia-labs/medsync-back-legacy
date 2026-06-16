const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');

class TenantOperationalDao {
    async getBusiness(idBusiness) {
        if (!idBusiness) {
            return null;
        }

        const rows = await sequelize.query(
            `SELECT
                    id_business,
                    active,
                    status,
                    subscription_status,
                    trial_starts_at,
                    trial_ends_at,
                    current_period_starts_at,
                    current_period_ends_at,
                    suspended_at,
                    cancelled_at,
                    status_reason
               FROM business
              WHERE id_business COLLATE utf8mb4_unicode_ci = :_id_business COLLATE utf8mb4_unicode_ci
              LIMIT 1`,
            {
                replacements: {
                    _id_business: idBusiness
                },
                type: QueryTypes.SELECT
            }
        );

        return rows && rows[0] ? rows[0] : null;
    }
}

module.exports = new TenantOperationalDao();

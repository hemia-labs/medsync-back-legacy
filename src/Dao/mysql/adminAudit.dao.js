const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');

class AdminAuditDao {
    constructor(database = sequelize) { this.db = database; }
    async record(action, context = {}, options = {}) {
        try {
            await this.db.query(
                `INSERT INTO admin_audit_log (
                    id_admin_audit_log,
                    actor_login_id,
                    actor_role,
                    action,
                    target_type,
                    target_id,
                    target_login_id,
                    target_business_id,
                    metadata_json,
                    ip,
                    user_agent,
                    created_at
                ) VALUES (
                    UUID(),
                    :_actor_login_id,
                    :_actor_role,
                    :_action,
                    :_target_type,
                    :_target_id,
                    :_target_login_id,
                    :_target_business_id,
                    :_metadata_json,
                    :_ip,
                    :_user_agent,
                    NOW()
                )`,
                {
                    replacements: {
                        _actor_login_id: context.actor_login_id || null,
                        _actor_role: context.actor_role || null,
                        _action: action,
                        _target_type: context.target_type || null,
                        _target_id: context.target_id || null,
                        _target_login_id: context.target_login_id || null,
                        _target_business_id: context.target_business_id || null,
                        _metadata_json: context.metadata ? JSON.stringify(context.metadata) : null,
                        _ip: context.ip || null,
                        _user_agent: context.user_agent || null
                    },
                    type: QueryTypes.INSERT,
                    transaction: options.transaction || null
                }
            );

            return true;
        } catch (error) {
            if (options.strict) throw error;
            return false;
        }
    }
}

module.exports = new AdminAuditDao();
module.exports.AdminAuditDao = AdminAuditDao;

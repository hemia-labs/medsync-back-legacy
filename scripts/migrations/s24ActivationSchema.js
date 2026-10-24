'use strict';
const statements=[`CREATE TABLE registration_account (
    id_login VARCHAR(50) COLLATE utf8mb4_unicode_ci PRIMARY KEY,
    id_business VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL UNIQUE,
    activation_completed_at DATETIME(3) NULL,
    setup_welcome_acknowledged_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CHECK (setup_welcome_acknowledged_at IS NULL OR activation_completed_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`];
const backfill=`INSERT INTO registration_account(id_login,id_business)
    SELECT DISTINCT a.target_login_id,a.target_business_id FROM admin_audit_log a
    JOIN login l ON l.id_login=a.target_login_id AND l.id_business=a.target_business_id
    JOIN business b ON b.id_business=l.id_business
    WHERE a.action='SELF_REGISTRATION_CREATED' AND l.created_by=l.id_login AND b.created_by=l.id_login
    ON DUPLICATE KEY UPDATE id_login=registration_account.id_login`;
module.exports={statements,backfill};

'use strict';

const tables = {
    auth_identity: `CREATE TABLE auth_identity (
        kind VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        normalized_value VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        id_login VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
        reservation_status VARCHAR(12) NOT NULL,
        expires_at DATETIME(3) NULL,
        verified_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (kind, normalized_value),
        KEY idx_identity_owner (id_login, kind),
        KEY idx_identity_expiry (reservation_status, expires_at),
        CONSTRAINT chk_s24_identity_kind CHECK (kind IN ('phone','email')),
        CONSTRAINT chk_s24_identity_state CHECK (
            (reservation_status='pending' AND expires_at IS NOT NULL AND verified_at IS NULL)
            OR (reservation_status='legacy' AND expires_at IS NULL AND verified_at IS NULL)
            OR (reservation_status='verified' AND expires_at IS NULL AND verified_at IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    registration_attempt: `CREATE TABLE registration_attempt (
        attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        scope_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        id_login VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
        id_business VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        expires_at DATETIME(3) NOT NULL,
        KEY idx_registration_attempt_expiry (expires_at),
        KEY idx_registration_attempt_owner (id_login)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
};

const functions = {
    s24_phone: `CREATE FUNCTION s24_phone(raw_value VARCHAR(500) CHARACTER SET utf8mb4) RETURNS VARCHAR(15) CHARACTER SET ascii
    DETERMINISTIC NO SQL
    BEGIN
        DECLARE value_normalized VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
        SET value_normalized = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(raw_value), ' ', ''), '(', ''), ')', ''), '-', ''), '.', '');
        IF value_normalized REGEXP '^[+]52[0-9]{10}$' THEN SET value_normalized = SUBSTRING(value_normalized, 4);
        ELSEIF value_normalized REGEXP '^52[0-9]{10}$' THEN SET value_normalized = SUBSTRING(value_normalized, 3); END IF;
        IF value_normalized IS NULL OR value_normalized REGEXP '[[:space:][:cntrl:]]'
           OR value_normalized NOT REGEXP '^[0-9]{7,15}$' THEN RETURN NULL; END IF;
        RETURN value_normalized;
    END`,
    s24_email: `CREATE FUNCTION s24_email(raw_value VARCHAR(500) CHARACTER SET utf8mb4) RETURNS VARCHAR(254) CHARACTER SET ascii
    DETERMINISTIC NO SQL
    BEGIN
        DECLARE value_normalized VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
        SET value_normalized = LOWER(TRIM(raw_value));
        IF value_normalized IS NULL OR CHAR_LENGTH(value_normalized)>254
           OR value_normalized REGEXP '[[:space:][:cntrl:]]'
           OR value_normalized NOT REGEXP '^[a-z0-9.!#$%&''*+/=?^_${String.fromCharCode(96)}{|}~-]+@[a-z0-9-]+([.][a-z0-9-]+)+$'
           OR OCTET_LENGTH(value_normalized) <> CHAR_LENGTH(value_normalized) THEN RETURN NULL; END IF;
        RETURN value_normalized;
    END`
};

const procedures = {
    s24_claim_identity: `CREATE PROCEDURE s24_claim_identity(
        IN identity_kind VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin,
        IN identity_value VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin,
        IN owner_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci, IN is_pending TINYINT)
    BEGIN
        DECLARE current_owner VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        DECLARE current_status VARCHAR(12);
        DECLARE current_expiry DATETIME(3);
        IF identity_value IS NULL OR identity_value = '' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'REG_IDENTITY_INVALID';
        END IF;
        INSERT INTO auth_identity (kind, normalized_value, id_login, reservation_status, expires_at)
        VALUES (identity_kind, identity_value, owner_id, IF(is_pending=1, 'pending', 'legacy'),
                IF(is_pending=1, DATE_ADD(NOW(3), INTERVAL 24 HOUR), NULL))
        ON DUPLICATE KEY UPDATE normalized_value=auth_identity.normalized_value;
        SELECT id_login, reservation_status, expires_at INTO current_owner, current_status, current_expiry
          FROM auth_identity WHERE kind=identity_kind AND normalized_value=identity_value FOR UPDATE;
        IF current_owner <> owner_id THEN
            IF current_status='pending' AND current_expiry<=NOW(3) THEN
                UPDATE auth_identity SET id_login=owner_id, reservation_status=IF(is_pending=1,'pending','legacy'),
                    expires_at=IF(is_pending=1,DATE_ADD(NOW(3),INTERVAL 24 HOUR),NULL), verified_at=NULL, updated_at=NOW(3)
                 WHERE kind=identity_kind AND normalized_value=identity_value;
            ELSE SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'REG_IDENTITY_CONFLICT';
            END IF;
        END IF;
        -- Existing owner's expiry is never extended by an unrelated login update.
        -- 'legacy' protects existing ownership; it is NOT proof of verification.
    END`
};

function trigger(event) {
    return `CREATE TRIGGER s24_login_${event.toLowerCase()} AFTER ${event} ON login FOR EACH ROW
    BEGIN
        DECLARE pending_account TINYINT DEFAULT 0;
        SELECT COALESCE(MAX(subscription_status='pending_activation'),0) INTO pending_account
          FROM business WHERE id_business=NEW.id_business;
        CALL s24_claim_identity('phone',s24_phone(NEW.telephone),NEW.id_login,pending_account);
        CALL s24_claim_identity('email',s24_email(NEW.email),NEW.id_login,pending_account);
    END`;
}
const triggers = { s24_login_insert: trigger('INSERT'), s24_login_update: trigger('UPDATE') };
const statements = [...Object.values(tables), ...Object.values(functions), ...Object.values(procedures), ...Object.values(triggers)];

// Run with writers stopped, after preflight. No credential/data export; no DELETE.
async function backfill(db) {
    await db.query(`INSERT INTO auth_identity (kind,normalized_value,id_login,reservation_status)
        SELECT 'phone',s24_phone(telephone),id_login,'legacy' FROM login`);
    await db.query(`INSERT INTO auth_identity (kind,normalized_value,id_login,reservation_status)
        SELECT 'email',s24_email(email),id_login,'legacy' FROM login`);
}

module.exports = { tables, functions, procedures, triggers, statements, backfill };

'use strict';
// Additive only. No foreign keys to clinical data and no plaintext OTP storage.
const statements = [
    `ALTER TABLE auth_identity DROP CHECK chk_s24_identity_state,
        ADD CONSTRAINT chk_s24_identity_state CHECK (
            (reservation_status='pending' AND expires_at IS NOT NULL AND verified_at IS NULL)
            OR (reservation_status IN ('legacy','reserved') AND expires_at IS NULL AND verified_at IS NULL)
            OR (reservation_status='verified' AND expires_at IS NULL AND verified_at IS NOT NULL))`,
    `CREATE TABLE registration_rate_bucket (
        bucket_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        hits INT UNSIGNED NOT NULL, expires_at DATETIME(3) NOT NULL,
        KEY idx_registration_rate_expiry (expires_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE registration_contact_challenge (
        challenge_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        id_login VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
        id_business VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
        channel VARCHAR(5) NOT NULL, purpose VARCHAR(30) NOT NULL,
        destination_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        status VARCHAR(20) NOT NULL, guesses INT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), expires_at DATETIME(3) NOT NULL,
        consumed_at DATETIME(3) NULL,
        KEY idx_registration_challenge_actor (id_login, channel, created_at),
        KEY idx_registration_challenge_expiry (expires_at),
        CHECK (channel IN ('sms','email')),
        CHECK (purpose='registration_contact'),
        CHECK (status IN ('sending','sent','failed','superseded','consumed','locked'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];
module.exports = { statements };

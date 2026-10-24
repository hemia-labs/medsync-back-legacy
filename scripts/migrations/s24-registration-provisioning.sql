-- R2-B additive; apply after R2-A. No account, publication or provider side effect.
-- Existing partial state must be inspected; no automatic DROP/down migration.
CREATE TABLE registration_outbox (
    event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_type VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    id_login VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_business VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    created_at DATETIME(3) NOT NULL,
    processed_at DATETIME(3) NULL,
    UNIQUE KEY uq_registration_event (attempt_id,event_type),
    KEY idx_registration_outbox_pending (processed_at,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

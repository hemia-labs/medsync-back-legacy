-- CO21. Run after a schema backup, with the previous app stopped during rollout.
-- Additive; no appointments, configurations or stored procedures are replaced.
ALTER TABLE appointment ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE appointment_config ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 1;
CREATE TABLE appointment_write_request (
  id_business VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  request_id VARCHAR(80) COLLATE utf8mb4_bin NOT NULL,
  actor_id VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  operation VARCHAR(24) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  appointment_id VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(id_business, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE appointment_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_business VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  appointment_id VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  actor_id VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  operation VARCHAR(24) NOT NULL,
  revision INT UNSIGNED NOT NULL,
  changes JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(id), KEY ix_appointment_audit(id_business, appointment_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

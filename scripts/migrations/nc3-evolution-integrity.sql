-- NC3: referencia de integridad de las notas de evolución firmadas. Aditiva e idempotente.
-- No modifica evolution_note_signed_version ni rellena asientos para notas heredadas.
CREATE TABLE IF NOT EXISTS evolution_integrity_ledger (
  id_business VARCHAR(50) NOT NULL,
  id_person VARCHAR(50) NOT NULL,
  seq BIGINT UNSIGNED NOT NULL,
  note_id CHAR(36) NOT NULL,
  version INT UNSIGNED NOT NULL,
  format VARCHAR(30) NOT NULL,
  digest CHAR(64) NOT NULL,
  previous_digest CHAR(64) NULL,
  prev_mac CHAR(64) NOT NULL,
  sealed_at DATETIME(6) NOT NULL,
  key_id VARCHAR(40) NOT NULL,
  mac CHAR(64) NOT NULL,
  PRIMARY KEY (id_business,id_person,seq),
  UNIQUE KEY uq_evolution_integrity_version (id_business,id_person,note_id,version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS evolution_integrity_head (
  id_business VARCHAR(50) NOT NULL,
  id_person VARCHAR(50) NOT NULL,
  last_seq BIGINT UNSIGNED NOT NULL,
  last_mac CHAR(64) NOT NULL,
  key_id VARCHAR(40) NOT NULL,
  mac CHAR(64) NOT NULL,
  PRIMARY KEY (id_business,id_person)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

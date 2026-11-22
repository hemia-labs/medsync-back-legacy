-- NC3/C22 R2: cola durable de entrega de referencias al testigo externo y estado externo por versión.
-- Aditiva e idempotente. Una fila por versión firmada, escrita en la MISMA transacción que la firma. No guarda texto clínico.
-- Reversión: la tabla puede conservarse (inerte) o eliminarse; no afecta a las notas ni a la cadena de integridad.
CREATE TABLE IF NOT EXISTS evolution_integrity_delivery (
  id_business VARCHAR(50) NOT NULL,
  id_person VARCHAR(50) NOT NULL,
  note_id CHAR(36) NOT NULL,
  version INT UNSIGNED NOT NULL,
  seq BIGINT UNSIGNED NOT NULL,
  state VARCHAR(12) NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  queued_at DATETIME(6) NOT NULL,
  last_attempt_at DATETIME(6) NULL,
  next_attempt_at DATETIME(6) NOT NULL,
  acked_at DATETIME(6) NULL,
  last_error VARCHAR(40) NULL,
  claim_token CHAR(36) NULL,
  claimed_until DATETIME(6) NULL,
  PRIMARY KEY (id_business,id_person,note_id,version),
  KEY idx_delivery_pending (state,next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

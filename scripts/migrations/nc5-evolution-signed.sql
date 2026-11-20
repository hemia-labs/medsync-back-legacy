CREATE TABLE IF NOT EXISTS evolution_note_signed_version (
  id_business VARCHAR(50) NOT NULL,
  id_person VARCHAR(50) NOT NULL,
  note_id CHAR(36) NOT NULL,
  version INT UNSIGNED NOT NULL,
  draft_revision INT UNSIGNED NOT NULL,
  request_id CHAR(36) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  author_id VARCHAR(50) NOT NULL,
  signer_profile VARCHAR(50) NOT NULL,
  signer_name VARCHAR(255) NOT NULL,
  signer_license VARCHAR(100) NOT NULL,
  signed_at DATETIME(6) NOT NULL,
  payload JSON NOT NULL,
  correction_reason VARCHAR(1000) NULL,
  PRIMARY KEY (id_business,id_person,note_id,version),
  UNIQUE KEY uq_evolution_request (id_business,id_person,note_id,request_id),
  KEY idx_evolution_patient (id_business,id_person,signed_at,note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

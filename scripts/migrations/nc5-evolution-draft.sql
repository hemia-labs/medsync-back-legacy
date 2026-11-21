CREATE TABLE IF NOT EXISTS evolution_note_draft (
    id_business VARCHAR(50) NOT NULL,
    id_person VARCHAR(50) NOT NULL,
    author_id VARCHAR(50) NOT NULL,
    draft_id CHAR(36) NOT NULL,
    appointment_id VARCHAR(50) NULL,
    revision INT UNSIGNED NOT NULL,
    payload JSON NOT NULL,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id_business,id_person,author_id,draft_id),
    UNIQUE KEY uq_draft_visit (id_business,id_person,author_id,appointment_id),
    KEY idx_draft_recent (id_business,id_person,author_id,updated_at,draft_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Apply to the notes database before enabling NC5. Both sources use the same
-- patient row lock as TreatmentPlanDao.mutation. No historical rows are imported.
CREATE TABLE IF NOT EXISTS evolution_note_performed_extra (
  id_extra CHAR(36) NOT NULL,
  id_business VARCHAR(50) NOT NULL,
  id_person VARCHAR(50) NOT NULL,
  id_note VARCHAR(50) NOT NULL,
  name_snapshot VARCHAR(255) NOT NULL,
  performed_on DATE NOT NULL,
  created_by VARCHAR(50) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id_treatment_plan VARCHAR(50) NULL,
  PRIMARY KEY (id_extra),
  UNIQUE KEY uq_note_extra (id_business, id_person, id_note),
  KEY idx_waiting_plan (id_business, id_person, id_treatment_plan)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


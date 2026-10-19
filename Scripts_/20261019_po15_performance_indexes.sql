-- PO15 historical migration: eight secondary indexes applied on 2026-10-19.
-- For re-runs use scripts/ops/po15-apply-indexes.js (live duplicate/target checks).
-- These statements are not loaded at application startup. No clinical row changes.

ALTER TABLE `person` ADD INDEX `idx_po14_person_tenant_active` (`id_business`, `active`, `created_at`, `id_person`), ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `patient_documents` ADD INDEX `idx_po14_documents_page` (`id_business`, `id_person`, `active`, `created_at` DESC, `id_patient_document` DESC), ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `prescription` ADD INDEX `idx_po14_prescription_page` (`id_business`, `active`, `issue_date` DESC, `created_at` DESC, `id_prescription` DESC), ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `prescription` ADD INDEX `idx_po14_prescription_patient_page` (`id_business`, `id_person`, `active`, `issue_date` DESC, `created_at` DESC, `id_prescription` DESC), ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `treatment_plan` ADD INDEX `idx_po14_plan_page` (`id_business`, `id_person`, `active`, `created_at` DESC, `id_treatment_plan` DESC), ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `patient_treatment` ADD INDEX `idx_po14_treatment_selected_plans` (`id_business`, `id_person`, `id_treatment_plan`, `active`), ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `appointment` ADD INDEX `idx_po14_retention_patient` (`id_business`, `id_person`, `active`, `status`, `appointment_date`, `start_time`), ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `treatment_plan_consent_document` ADD INDEX `idx_po14_plan_document_latest` (`id_business`, `id_person`, `id_treatment_plan`, `prepared_at` DESC, `id_patient_document` DESC), ALGORITHM=INPLACE, LOCK=NONE;

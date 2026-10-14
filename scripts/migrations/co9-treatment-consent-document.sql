CREATE TABLE IF NOT EXISTS treatment_plan_consent_document (
    id_patient_document varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_business varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_person varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_treatment_plan varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    doctor_user_id varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    content_fingerprint char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    plan_snapshot_json longtext COLLATE utf8mb4_unicode_ci NOT NULL,
    consent_snapshot_json longtext COLLATE utf8mb4_unicode_ci NOT NULL,
    prepared_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    prepared_by varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    PRIMARY KEY (id_patient_document),
    KEY idx_plan_consent_document_patient (id_business, id_person, id_treatment_plan),
    CONSTRAINT fk_plan_consent_document FOREIGN KEY (id_patient_document) REFERENCES patient_documents(id_patient_document),
    CONSTRAINT fk_plan_consent_document_plan FOREIGN KEY (id_treatment_plan) REFERENCES treatment_plan(id_treatment_plan)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

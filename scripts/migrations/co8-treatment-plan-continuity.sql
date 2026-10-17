-- Additive migration: does not alter/delete existing consents or clinical data.
CREATE TABLE IF NOT EXISTS treatment_plan_consent_version (
    id_consent_version varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_business varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_person varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_treatment_plan varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    revision int unsigned NOT NULL,
    request_id varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    consent_snapshot_json longtext COLLATE utf8mb4_unicode_ci NOT NULL,
    plan_snapshot_json longtext COLLATE utf8mb4_unicode_ci,
    created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    PRIMARY KEY (id_consent_version),
    UNIQUE KEY uk_consent_revision (id_business, id_treatment_plan, revision),
    UNIQUE KEY uk_consent_request (id_business, id_treatment_plan, request_id),
    KEY idx_consent_version_patient (id_business, id_person),
    CONSTRAINT fk_consent_version_plan FOREIGN KEY (id_treatment_plan) REFERENCES treatment_plan(id_treatment_plan)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS treatment_plan_audit (
    id_plan_audit varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_business varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_person varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_treatment_plan varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    previous_snapshot_json longtext COLLATE utf8mb4_unicode_ci NOT NULL,
    new_snapshot_json longtext COLLATE utf8mb4_unicode_ci NOT NULL,
    created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    PRIMARY KEY (id_plan_audit),
    KEY idx_plan_audit_plan (id_business, id_treatment_plan),
    CONSTRAINT fk_plan_audit_plan FOREIGN KEY (id_treatment_plan) REFERENCES treatment_plan(id_treatment_plan)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

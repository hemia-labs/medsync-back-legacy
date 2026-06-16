CREATE TABLE IF NOT EXISTS business_license_overrides (
    id VARCHAR(50) NOT NULL,
    id_business VARCHAR(50) NOT NULL,
    extra_professionals INT NOT NULL DEFAULT 0,
    extra_auxiliary_users INT NOT NULL DEFAULT 0,
    extra_branches INT NOT NULL DEFAULT 0,
    reason VARCHAR(500) NULL,
    valid_until DATETIME NULL,
    created_by VARCHAR(50) NULL,
    updated_by VARCHAR(50) NULL,
    created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_business_license_overrides_business (id_business),
    KEY idx_business_license_overrides_business (id_business),
    KEY idx_business_license_overrides_valid_until (valid_until)
);

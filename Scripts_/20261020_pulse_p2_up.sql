-- PULSE2 explicit migration. Apply only to identified synthetic QA in this phase.
-- No grants, no changes to source clinical tables or indexes, no automatic startup DDL.
CREATE TABLE IF NOT EXISTS business_pulse_captures (
 id_business VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
 local_date DATE NOT NULL,
 cut_kind VARCHAR(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'daily18',
 state ENUM('claimed','valid','partial','gap') NOT NULL,
 lease_owner CHAR(36) COLLATE utf8mb4_unicode_ci NULL,
 lease_until DATETIME(3) NULL,
 captured_at DATETIME(3) NULL,
 expires_at DATETIME(3) NOT NULL,
 time_zone VARCHAR(80) COLLATE utf8mb4_unicode_ci NOT NULL,
 rules_version VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
 catalog_version VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
 aggregate_json JSON NULL,
 reason_code VARCHAR(64) COLLATE utf8mb4_unicode_ci NULL,
 PRIMARY KEY (id_business,local_date,cut_kind),
 KEY idx_pulse_expiry(expires_at),
 CONSTRAINT pulse_capture_business_fk FOREIGN KEY(id_business) REFERENCES business(id_business) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO cat_permission(id_cat_permission,code,name,description,sec,value,active,is_active)
VALUES('pulse-view-business-v1','pulse.view.business','Ver el Pulso del consultorio',
 'Estado institucional. Requiere tambien dashboard.scope.all, dashboard.operations y dashboard.clinical. No concede acceso al expediente ni permiso para editar.',70,'pulse',1,1);

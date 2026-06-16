-- Fase 12A - Migracion SaaS de negocio
-- Objetivo: separar estado tecnico de estado comercial SaaS en business.
-- Seguro/idempotente: no borra columnas, no renombra, no toca tablas clinicas.
-- Compatible con ejecucion por driver SQL: no usa DELIMITER ni procedimiento almacenado.

SET @schema_name = DATABASE();

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE business ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1',
        'SELECT ''active already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND COLUMN_NAME = 'active'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE business ADD COLUMN plan VARCHAR(100) NULL DEFAULT ''basic''',
        'SELECT ''plan already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND COLUMN_NAME = 'plan'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE business ADD COLUMN subscription_status VARCHAR(30) NOT NULL DEFAULT ''trial''',
        'SELECT ''subscription_status already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND COLUMN_NAME = 'subscription_status'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE business ADD COLUMN trial_starts_at DATETIME NULL',
        'SELECT ''trial_starts_at already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND COLUMN_NAME = 'trial_starts_at'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE business ADD COLUMN trial_ends_at DATETIME NULL',
        'SELECT ''trial_ends_at already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND COLUMN_NAME = 'trial_ends_at'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE business ADD COLUMN current_period_starts_at DATETIME NULL',
        'SELECT ''current_period_starts_at already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND COLUMN_NAME = 'current_period_starts_at'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE business ADD COLUMN current_period_ends_at DATETIME NULL',
        'SELECT ''current_period_ends_at already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND COLUMN_NAME = 'current_period_ends_at'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE business ADD COLUMN suspended_at DATETIME NULL',
        'SELECT ''suspended_at already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND COLUMN_NAME = 'suspended_at'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE business ADD COLUMN cancelled_at DATETIME NULL',
        'SELECT ''cancelled_at already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND COLUMN_NAME = 'cancelled_at'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE business ADD COLUMN status_reason VARCHAR(500) NULL',
        'SELECT ''status_reason already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND COLUMN_NAME = 'status_reason'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE business
   SET subscription_status = CASE
            WHEN subscription_status IS NULL OR TRIM(subscription_status) = '' THEN 'trial'
            WHEN subscription_status NOT IN ('trial', 'active', 'past_due', 'suspended', 'cancelled') THEN 'trial'
            ELSE subscription_status
       END,
       trial_starts_at = CASE
            WHEN trial_starts_at IS NULL THEN COALESCE(created_at, NOW())
            ELSE trial_starts_at
       END,
       trial_ends_at = CASE
            WHEN trial_ends_at IS NULL THEN DATE_ADD(COALESCE(created_at, NOW()), INTERVAL 60 DAY)
            ELSE trial_ends_at
       END,
       active = COALESCE(active, 1),
       status = CASE
            WHEN status IS NULL OR TRIM(status) = '' THEN 'active'
            ELSE status
       END,
       plan = CASE
            WHEN plan IS NULL OR TRIM(plan) = '' THEN 'basic'
            ELSE plan
       END;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'CREATE INDEX idx_business_subscription_status ON business (subscription_status)',
        'SELECT ''idx_business_subscription_status already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND INDEX_NAME = 'idx_business_subscription_status'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'CREATE INDEX idx_business_trial_ends_at ON business (trial_ends_at)',
        'SELECT ''idx_business_trial_ends_at already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND INDEX_NAME = 'idx_business_trial_ends_at'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'CREATE INDEX idx_business_active ON business (active)',
        'SELECT ''idx_business_active already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND INDEX_NAME = 'idx_business_active'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        COUNT(*) = 0,
        'CREATE INDEX idx_business_plan ON business (plan)',
        'SELECT ''idx_business_plan already exists'' AS info'
    )
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @schema_name
      AND TABLE_NAME = 'business'
      AND INDEX_NAME = 'idx_business_plan'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT
    COUNT(*) AS total_businesses,
    SUM(CASE WHEN subscription_status = 'trial' THEN 1 ELSE 0 END) AS trial_businesses,
    SUM(CASE WHEN trial_starts_at IS NOT NULL THEN 1 ELSE 0 END) AS with_trial_starts_at,
    SUM(CASE WHEN trial_ends_at IS NOT NULL THEN 1 ELSE 0 END) AS with_trial_ends_at,
    SUM(CASE WHEN plan IS NULL OR TRIM(plan) = '' THEN 1 ELSE 0 END) AS without_plan
FROM business;

-- CO21 rollback: stop CO21 writers first and restore the preceding application.
-- Preserve audit/replay records for recovery; do not drop their data.
RENAME TABLE appointment_write_request TO appointment_write_request_co21_rollback,
             appointment_audit TO appointment_audit_co21_rollback;
ALTER TABLE appointment DROP COLUMN revision;
ALTER TABLE appointment_config DROP COLUMN revision;

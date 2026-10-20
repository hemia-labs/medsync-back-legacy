-- MANUAL read-only inspection, not run by the app or test suite.
-- Use ONE connection and sequential statements. Confirm the intended QA server first.
-- No patient rows, SQL_TEXT, credentials, reset commands, ANALYZE TABLE or EXPLAIN ANALYZE.
SELECT VERSION() AS mysql_version, @@innodb_buffer_pool_size AS buffer_pool_bytes,
       @@max_connections AS max_connections, @@performance_schema AS performance_schema;
SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections',
    'Questions','Created_tmp_tables','Created_tmp_disk_tables','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests');
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, CARDINALITY
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('person','appointment','patient_documents','prescription','prescription_item','treatment_plan',
    'patient_treatment','treatment_plan_consent_document','treatment_plan_consent_version')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
-- Aggregate digests have no SQL text or literal patient data. Privileges/availability vary by server.
SELECT DIGEST, COUNT_STAR, SUM_TIMER_WAIT / 1000000000000 AS total_seconds,
    AVG_TIMER_WAIT / 1000000000 AS mean_ms, SUM_ROWS_EXAMINED, SUM_ROWS_SENT,
    SUM_CREATED_TMP_DISK_TABLES, SUM_NO_INDEX_USED
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = DATABASE() AND DIGEST IS NOT NULL
ORDER BY SUM_TIMER_WAIT DESC LIMIT 25;
-- Repeat status/digests after a defined QA workload; compare deltas, not cumulative totals alone.
-- Synthetic example only: replace parameters on isolated QA with representative synthetic data.
SET @po14_business = '__PO14_QA_TENANT__';
SET @po14_patient = '__PO14_QA_PATIENT__';
EXPLAIN FORMAT=JSON SELECT id_patient_document, created_at FROM patient_documents
 WHERE id_business = @po14_business AND id_person = @po14_patient AND active = 1
 ORDER BY created_at DESC, id_patient_document DESC LIMIT 10 OFFSET 0;
EXPLAIN FORMAT=JSON SELECT id_prescription, issue_date, created_at FROM prescription
 WHERE id_business = @po14_business AND id_person = @po14_patient AND active = 1
 ORDER BY issue_date DESC, created_at DESC, id_prescription DESC LIMIT 10 OFFSET 0;
EXPLAIN FORMAT=JSON SELECT id_treatment_plan, created_at FROM treatment_plan
 WHERE id_business = @po14_business AND id_person = @po14_patient AND active = 1 AND status <> 'active'
 ORDER BY created_at DESC, id_treatment_plan DESC LIMIT 5 OFFSET 0;
-- Also EXPLAIN the exact DAO joins/filters and firstVisitRetentionSummary (own and business scopes).
-- These reduced projections do not prove the plans of the full application queries.

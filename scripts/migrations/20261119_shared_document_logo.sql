-- UI-LOGO-RECIPES: apply before the shared-logo backend release.
-- Additive only. NULL means historical logo not recorded. No backfill.
-- Run once, after verifying the column is absent in information_schema.columns.
-- Rollback: revert application code; retain the column and captured images.
ALTER TABLE clinical_histories
  ADD COLUMN document_logo_snapshot_json LONGTEXT NULL;

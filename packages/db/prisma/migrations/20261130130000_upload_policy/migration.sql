-- Additive nullable column. Previous releases do not read or write it.
-- Null means no persisted override. The column stores bytes, at most 26214400 in this phase.
-- Leaving the column after a code rollback is safe. Dropping it is safe only after this code is gone.
-- This migration does not drop or rewrite existing rows.
ALTER TABLE "deployment_settings" ADD COLUMN "maxUploadSizeBytes" INTEGER;

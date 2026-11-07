-- Additive nullable column. Previous releases do not read or write it.
-- Null means no persisted override. Dropping it is safe only after this release is gone;
-- this migration does not drop anything.
ALTER TABLE "deployment_settings" ADD COLUMN "maxUploadSizeBytes" INTEGER;

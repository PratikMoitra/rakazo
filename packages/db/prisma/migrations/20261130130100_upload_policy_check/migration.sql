-- Fail closed on a persisted upload limit that is not a whole mebibyte from 1 through 25.
-- Null remains the unset value. This does not rewrite existing rows.
-- Previous releases ignore the column. A code rollback can leave the check in place:
-- old code writes only null or never touches the column, so the check does not reject it.
ALTER TABLE "deployment_settings"
  ADD CONSTRAINT "deployment_settings_max_upload_bytes_check"
  CHECK (
    "maxUploadSizeBytes" IS NULL
    OR (
      "maxUploadSizeBytes" >= 1048576
      AND "maxUploadSizeBytes" <= 26214400
      AND "maxUploadSizeBytes" % 1048576 = 0
    )
  );

// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import {
  DEFAULT_UPLOAD_MAX_BYTES,
  UPLOAD_POLICY_INVALID_CODE,
  UPLOAD_POLICY_LOCKED_CODE,
} from "@rakazo/contracts";
import { AttachmentValidationError } from "./attachments.js";

const MIB = 1024 * 1024;

/** This phase never allocates more than 25 MiB for one file, whatever the caller passes. */
export function boundedUploadCeiling(bytes: number | undefined): number {
  if (!Number.isSafeInteger(bytes) || bytes === undefined || bytes < 1)
    return DEFAULT_UPLOAD_MAX_BYTES;
  return Math.min(bytes, DEFAULT_UPLOAD_MAX_BYTES);
}

export type UploadPolicySource = "env" | "persisted" | "default" | "invalid";

export type UploadPolicyView = {
  maxFileBytes: number;
  ceilingBytes: number;
  source: UploadPolicySource;
  envLocked: boolean;
};

/** Explicit MAX_UPLOAD_SIZE_MB wins. Otherwise a stored whole-MiB value at or under the ceiling. */
export function effectiveUploadPolicy(input: {
  ceilingBytes: number;
  envExplicit: boolean;
  persistedBytes?: number | null;
}): UploadPolicyView {
  const ceiling = boundedUploadCeiling(input.ceilingBytes);
  if (input.envExplicit) {
    return { maxFileBytes: ceiling, ceilingBytes: ceiling, source: "env", envLocked: true };
  }
  const persisted = input.persistedBytes;
  if (persisted != null && !isWholeMibWithin(persisted, ceiling)) {
    return { maxFileBytes: 1, ceilingBytes: ceiling, source: "invalid", envLocked: false };
  }
  if (isWholeMibWithin(persisted, ceiling)) {
    return {
      maxFileBytes: persisted,
      ceilingBytes: ceiling,
      source: "persisted",
      envLocked: false,
    };
  }
  return { maxFileBytes: ceiling, ceilingBytes: ceiling, source: "default", envLocked: false };
}

/** Byte checks for a deployment setting. Organization role is not authority. */
export function proposeUploadPolicyChange(input: {
  envExplicit: boolean;
  ceilingBytes: number;
  maxFileBytes: number;
}): { maxFileBytes: number } {
  if (input.envExplicit) {
    throw new AttachmentValidationError(
      "The upload limit is set by the server configuration",
      UPLOAD_POLICY_LOCKED_CODE,
    );
  }
  const ceiling = boundedUploadCeiling(input.ceilingBytes);
  if (!isWholeMibWithin(input.maxFileBytes, ceiling)) {
    throw new AttachmentValidationError(
      "Upload policy must be a whole number of MiB within the server ceiling",
      UPLOAD_POLICY_INVALID_CODE,
    );
  }
  return { maxFileBytes: input.maxFileBytes };
}

function isWholeMibWithin(value: number | null | undefined, ceiling: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIB &&
    value <= ceiling &&
    value % MIB === 0
  );
}

// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import {
  UPLOAD_POLICY_FORBIDDEN_CODE,
  UPLOAD_POLICY_INVALID_CODE,
  UPLOAD_POLICY_LOCKED_CODE,
} from "@rakazo/contracts";
import { AttachmentValidationError } from "./attachments.js";

const MIB = 1024 * 1024;

export type UploadPolicySource = "env" | "persisted" | "default";

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
  const ceiling = input.ceilingBytes;
  if (input.envExplicit) {
    return { maxFileBytes: ceiling, ceilingBytes: ceiling, source: "env", envLocked: true };
  }
  const persisted = input.persistedBytes;
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

/** Owner or admin may store a whole number of MiB that does not exceed the process ceiling. */
export function proposeUploadPolicyChange(input: {
  role: string | null | undefined;
  envExplicit: boolean;
  ceilingBytes: number;
  maxFileBytes: number;
}): { maxFileBytes: number } {
  if (!uploadPolicyRoleAllowed(input.role)) {
    throw new AttachmentValidationError(
      "Only an owner or admin can change the upload policy",
      UPLOAD_POLICY_FORBIDDEN_CODE,
    );
  }
  if (input.envExplicit) {
    throw new AttachmentValidationError(
      "The upload limit is set by the server configuration",
      UPLOAD_POLICY_LOCKED_CODE,
    );
  }
  if (!isWholeMibWithin(input.maxFileBytes, input.ceilingBytes)) {
    throw new AttachmentValidationError(
      "Upload policy must be a whole number of MiB within the server ceiling",
      UPLOAD_POLICY_INVALID_CODE,
    );
  }
  return { maxFileBytes: input.maxFileBytes };
}

export function uploadPolicyRoleAllowed(role: string | null | undefined): boolean {
  if (!role) return false;
  const parts = role.split(",").map((value) => value.trim());
  return parts.includes("owner") || parts.includes("admin");
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

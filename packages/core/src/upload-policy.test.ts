// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import {
  DEFAULT_UPLOAD_MAX_BYTES,
  UPLOAD_POLICY_FORBIDDEN_CODE,
  UPLOAD_POLICY_INVALID_CODE,
  UPLOAD_POLICY_LOCKED_CODE,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { AttachmentValidationError } from "./attachments.js";
import { effectiveUploadPolicy, proposeUploadPolicyChange } from "./upload-policy.js";

const MIB = 1024 * 1024;

describe("effectiveUploadPolicy", () => {
  it("lets an explicit environment value win over a stored limit", () => {
    expect(
      effectiveUploadPolicy({
        ceilingBytes: 10 * MIB,
        envExplicit: true,
        persistedBytes: MIB,
      }),
    ).toEqual({
      maxFileBytes: 10 * MIB,
      ceilingBytes: 10 * MIB,
      source: "env",
      envLocked: true,
    });
  });

  it("uses a stored value under the ceiling and otherwise the default ceiling", () => {
    expect(
      effectiveUploadPolicy({
        ceilingBytes: DEFAULT_UPLOAD_MAX_BYTES,
        envExplicit: false,
        persistedBytes: 2 * MIB,
      }).source,
    ).toBe("persisted");
    expect(
      effectiveUploadPolicy({
        ceilingBytes: DEFAULT_UPLOAD_MAX_BYTES,
        envExplicit: false,
        persistedBytes: null,
      }),
    ).toMatchObject({ maxFileBytes: DEFAULT_UPLOAD_MAX_BYTES, source: "default" });
    expect(
      effectiveUploadPolicy({
        ceilingBytes: DEFAULT_UPLOAD_MAX_BYTES,
        envExplicit: false,
        persistedBytes: DEFAULT_UPLOAD_MAX_BYTES + MIB,
      }).source,
    ).toBe("default");
  });
});

describe("proposeUploadPolicyChange", () => {
  it("allows an owner or admin to store a whole MiB at the ceiling", () => {
    expect(
      proposeUploadPolicyChange({
        role: "owner",
        envExplicit: false,
        ceilingBytes: DEFAULT_UPLOAD_MAX_BYTES,
        maxFileBytes: DEFAULT_UPLOAD_MAX_BYTES,
      }),
    ).toEqual({ maxFileBytes: DEFAULT_UPLOAD_MAX_BYTES });
    expect(
      proposeUploadPolicyChange({
        role: "member, admin",
        envExplicit: false,
        ceilingBytes: DEFAULT_UPLOAD_MAX_BYTES,
        maxFileBytes: MIB,
      }).maxFileBytes,
    ).toBe(MIB);
  });

  it("denies other roles, an env lock, and a value above the ceiling", () => {
    expect(() =>
      proposeUploadPolicyChange({
        role: "member",
        envExplicit: false,
        ceilingBytes: DEFAULT_UPLOAD_MAX_BYTES,
        maxFileBytes: MIB,
      }),
    ).toThrow(expect.objectContaining({ code: UPLOAD_POLICY_FORBIDDEN_CODE }));
    expect(() =>
      proposeUploadPolicyChange({
        role: "owner",
        envExplicit: true,
        ceilingBytes: 10 * MIB,
        maxFileBytes: MIB,
      }),
    ).toThrow(expect.objectContaining({ code: UPLOAD_POLICY_LOCKED_CODE }));
    expect(() =>
      proposeUploadPolicyChange({
        role: "owner",
        envExplicit: false,
        ceilingBytes: DEFAULT_UPLOAD_MAX_BYTES,
        maxFileBytes: DEFAULT_UPLOAD_MAX_BYTES + 1,
      }),
    ).toThrow(AttachmentValidationError);
    expect(() =>
      proposeUploadPolicyChange({
        role: "owner",
        envExplicit: false,
        ceilingBytes: DEFAULT_UPLOAD_MAX_BYTES,
        maxFileBytes: DEFAULT_UPLOAD_MAX_BYTES + 1,
      }),
    ).toThrow(expect.objectContaining({ code: UPLOAD_POLICY_INVALID_CODE }));
  });
});

// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { ORPCError } from "@orpc/server";
import { UPLOAD_TOO_LARGE_CODE } from "@rakazo/contracts";
import { AttachmentValidationError } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { orpcAttachmentError } from "./attachment-error.js";

describe("orpcAttachmentError", () => {
  it("publishes the stable upload_too_large code without changing the bad-request status", () => {
    const error = orpcAttachmentError(
      new AttachmentValidationError("Attachment exceeds the 25 MiB limit", UPLOAD_TOO_LARGE_CODE),
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.status).toBe(400);
    expect(error.message).toContain("25 MiB");
    expect(error.data).toEqual({ code: "upload_too_large" });
  });
});

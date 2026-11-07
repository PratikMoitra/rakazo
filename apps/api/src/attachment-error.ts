// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { ORPCError } from "@orpc/server";
import type { AttachmentValidationError } from "@rakazo/core";

/** Maps a measured upload rejection onto the existing bad-request procedure error. */
export function orpcAttachmentError(error: AttachmentValidationError): ORPCError<string, unknown> {
  return new ORPCError("BAD_REQUEST", {
    message: error.message,
    data: { code: error.code },
  });
}

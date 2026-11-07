// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { attachmentMaxBytes, DEFAULT_UPLOAD_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { defaultApiBase, normalizeApiBase } from "./endpoint.js";
import { attachmentSkipReason } from "./pick-attachments-filter.js";

describe("phone upload and server contract", () => {
  it("uses one advertised per-file limit and falls back when a server omits it", () => {
    const advertised = attachmentMaxBytes({ maxUploadSizeBytes: DEFAULT_UPLOAD_MAX_BYTES });
    expect(advertised).toBe(26_214_400);
    expect(
      attachmentSkipReason(
        { name: "notes.txt", size: advertised, mimeType: "text/plain" },
        0,
        0,
        advertised,
      ),
    ).toBeNull();
    expect(
      attachmentSkipReason(
        { name: "notes.txt", size: advertised + 1, mimeType: "text/plain" },
        0,
        0,
        advertised,
      ),
    ).toBe("over 25 MiB");
    expect(attachmentMaxBytes(undefined)).toBe(10 * 1024 * 1024);
  });

  it("keeps the default server on loopback and accepts a private custom server", () => {
    expect(defaultApiBase()).toBe("http://127.0.0.1:3100");
    expect(normalizeApiBase("http://127.0.0.1:3100")).toEqual({
      ok: true,
      url: "http://127.0.0.1:3100",
    });
    expect(normalizeApiBase("http://192.168.1.20:3100/rpc")).toEqual({
      ok: true,
      url: "http://192.168.1.20:3100",
    });
  });
});

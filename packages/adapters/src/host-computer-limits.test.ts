// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { DEFAULT_UPLOAD_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { HOST_COMPUTER_MAX_BYTES, HOST_COMPUTER_MAX_FILE_BYTES } from "./host-computer-protocol.js";

describe("host computer transfer caps", () => {
  it("keeps the socket and file caps below the 25 MiB chat upload", () => {
    expect(HOST_COMPUTER_MAX_FILE_BYTES).toBe(8 * 1024 * 1024);
    expect(HOST_COMPUTER_MAX_BYTES).toBe(12 * 1024 * 1024);
    expect(HOST_COMPUTER_MAX_FILE_BYTES).toBeLessThan(DEFAULT_UPLOAD_MAX_BYTES);
    expect(HOST_COMPUTER_MAX_BYTES).toBeLessThan(DEFAULT_UPLOAD_MAX_BYTES);
  });
});

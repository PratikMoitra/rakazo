import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_DELETE_TIMEOUT_MS,
  CREDENTIAL_RETIREMENT_LEASE_SECONDS,
  credentialWorkerTarget,
} from "./queue-boundary.js";

const runtime = "postgres://rakazo_api:runtime-password@127.0.0.1:5432/rakazo";

describe("credentialWorkerTarget", () => {
  it("keeps the cleanup lease longer than the external delete", () => {
    expect(CREDENTIAL_RETIREMENT_LEASE_SECONDS * 1000).toBeGreaterThan(
      CREDENTIAL_DELETE_TIMEOUT_MS,
    );
  });
  it("leaves cleanup off when the worker URL is unset", () => {
    expect(credentialWorkerTarget(runtime, undefined)).toEqual({ mode: "off" });
  });

  it("rejects a blank or same-login worker URL", () => {
    expect(() => credentialWorkerTarget(runtime, "   ")).toThrow(/blank/);
    expect(() =>
      credentialWorkerTarget(runtime, "postgres://rakazo_api:other-password@127.0.0.1:5432/rakazo"),
    ).toThrow(/same login/);
  });

  it("rejects a login other than the managed worker", () => {
    expect(() =>
      credentialWorkerTarget(runtime, "postgres://rakazo_queue_owner:secret@127.0.0.1:5432/rakazo"),
    ).toThrow(/managed credential worker/);
  });

  it("accepts the managed worker login", () => {
    expect(
      credentialWorkerTarget(
        runtime,
        "postgres://rakazo_credential_worker:worker-password@127.0.0.1:5432/rakazo",
      ),
    ).toEqual({
      mode: "on",
      url: "postgres://rakazo_credential_worker:worker-password@127.0.0.1:5432/rakazo",
      login: "rakazo_credential_worker",
    });
  });
});

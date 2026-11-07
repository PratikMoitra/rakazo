import { describe, expect, it } from "vitest";
import { credentialWorkerTarget } from "./queue-boundary.js";

const runtime = "postgres://rakazo_api:runtime-password@127.0.0.1:5432/rakazo";

describe("credentialWorkerTarget", () => {
  it("leaves cleanup off when the worker URL is unset", () => {
    expect(credentialWorkerTarget(runtime, undefined)).toEqual({ mode: "off" });
  });

  it("rejects a blank or same-login worker URL", () => {
    expect(() => credentialWorkerTarget(runtime, "   ")).toThrow(/blank/);
    expect(() =>
      credentialWorkerTarget(runtime, "postgres://rakazo_api:other-password@127.0.0.1:5432/rakazo"),
    ).toThrow(/same login/);
  });

  it("accepts a distinct worker login", () => {
    expect(
      credentialWorkerTarget(
        runtime,
        "postgres://rakazo_worker:worker-password@127.0.0.1:5432/rakazo",
      ),
    ).toEqual({
      mode: "on",
      url: "postgres://rakazo_worker:worker-password@127.0.0.1:5432/rakazo",
      login: "rakazo_worker",
    });
  });
});

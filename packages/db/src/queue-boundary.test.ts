import { describe, expect, it } from "vitest";
import {
  assertPinnedWorkerEndpoint,
  CREDENTIAL_DELETE_TIMEOUT_MS,
  CREDENTIAL_RETIREMENT_LEASE_SECONDS,
  credentialWorkerTarget,
  migrationAuthProbe,
  preflightCredentialWorker,
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

describe("worker endpoint pin", () => {
  const migration = "postgres://migration-admin:migration-secret@trusted.example:5432/app";

  it("rejects an untrusted host before any connection is constructed", async () => {
    const hostile = "postgres://rakazo_credential_worker:worker-secret@untrusted.example:5432/app";
    const opened: string[] = [];
    expect(() => assertPinnedWorkerEndpoint(migration, hostile)).toThrow(
      /trusted migration endpoint/,
    );
    expect(migrationAuthProbe()).toBeNull();
    await expect(
      preflightCredentialWorker(migration, hostile, (connectionString) => {
        opened.push(connectionString);
        throw new Error("connection constructed");
      }),
    ).rejects.toThrow(/trusted migration endpoint/);
    expect(opened).toEqual([]);
    expect(() =>
      assertPinnedWorkerEndpoint(
        migration,
        "postgres://rakazo_credential_worker:worker-secret@127.0.0.1:5432/app",
      ),
    ).toThrow(/trusted migration endpoint/);
  });

  it("opens only the original migration endpoint when the worker URL is pinned", async () => {
    const worker = "postgres://rakazo_credential_worker:worker-secret@trusted.example:5432/app";
    const opened: string[] = [];
    let reads = 0;
    await preflightCredentialWorker(migration, worker, ((connectionString) => {
      opened.push(connectionString);
      return {
        async connect() {},
        async query() {
          reads += 1;
          if (reads === 1) {
            return {
              rows: [
                {
                  db: "app",
                  session_user: "migration-admin",
                  owner_name: "migration-admin",
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        async end() {},
      };
    }) as Parameters<typeof preflightCredentialWorker>[2]);
    expect(opened).toEqual([migration]);
  });
});

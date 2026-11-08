import { describe, expect, it } from "vitest";
import type { ExplicitPgConfig } from "./queue-boundary.js";
import {
  assertPinnedWorkerEndpoint,
  attestCredentialWorker,
  CREDENTIAL_DELETE_TIMEOUT_MS,
  CREDENTIAL_RETIREMENT_LEASE_SECONDS,
  credentialWorkerTarget,
  migrationAuthProbe,
  pinnedEndpointConfigs,
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
  const worker = "postgres://rakazo_credential_worker:worker-secret@trusted.example:5432/app";

  function refused(value: string) {
    return preflightCredentialWorker(migration, value, () => {
      throw new Error("connection constructed");
    });
  }

  it("rejects an untrusted host before any connection is constructed", async () => {
    const hostile = "postgres://rakazo_credential_worker:worker-secret@untrusted.example:5432/app";
    expect(() => assertPinnedWorkerEndpoint(migration, hostile)).toThrow(
      /trusted migration endpoint/,
    );
    expect(migrationAuthProbe()).toBeNull();
    await expect(refused(hostile)).rejects.toThrow(/trusted migration endpoint/);
    await expect(
      refused("postgres://rakazo_credential_worker:worker-secret@127.0.0.1:5432/app"),
    ).rejects.toThrow(/trusted migration endpoint/);
  });

  it("rejects query routing, authentication, socket, and TLS overrides before any client", async () => {
    const overrides = [
      "postgres://rakazo_credential_worker:worker-secret@trusted.example:5432/app?host=other.invalid&port=6543",
      "postgres://rakazo_credential_worker:worker-secret@trusted.example:5432/app?host=trusted.example&host=other.invalid",
      "postgres://rakazo_credential_worker:worker-secret@trusted.example:5432/app?%68ost=other.invalid",
      "postgres://rakazo_credential_worker:worker-secret@trusted.example:5432/app?user=migration-admin",
      "postgres://rakazo_credential_worker:worker-secret@trusted.example:5432/app?password=other-secret",
      "postgres://rakazo_credential_worker:worker-secret@trusted.example:5432/app?hostaddr=10.1.2.3",
      "postgres://rakazo_credential_worker:worker-secret@trusted.example:5432/app?sslmode=disable",
      "postgres://rakazo_credential_worker:worker-secret@trusted.example:5432/app?sslmode=no-verify",
      "socket:///tmp/pg.sock?db=app&user=rakazo_credential_worker",
      "postgres://rakazo_credential_worker:worker-secret@%2Ftmp%2Fpg.sock/app",
    ];
    for (const value of overrides) {
      expect(() => pinnedEndpointConfigs(migration, value)).toThrow(/trusted migration endpoint/);
    }
    await expect(refused(overrides[0] ?? "")).rejects.toThrow(/trusted migration endpoint/);
    expect(migrationAuthProbe()).toBeNull();
  });

  it("opens only the parsed migration config when the worker URL is pinned", async () => {
    const opened: ExplicitPgConfig[] = [];
    let reads = 0;
    await preflightCredentialWorker(migration, `${worker}?application_name=phase1`, ((config) => {
      opened.push(config);
      return {
        async connect() {},
        async query() {
          reads += 1;
          if (reads === 1) {
            return {
              rows: [{ db: "app", session_user: "migration-admin", owner_name: "migration-admin" }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        async end() {},
      };
    }) as Parameters<typeof preflightCredentialWorker>[2]);
    expect(opened.map((config) => config.user)).toEqual(["migration-admin"]);
    expect(opened.map((config) => config.host)).toEqual(["trusted.example"]);
    expect(opened.map((config) => config.port)).toEqual([5432]);
  });

  it("attests with the worker login on the trusted endpoint", async () => {
    const plan = pinnedEndpointConfigs(migration, worker);
    expect(plan.migration.user).toBe("migration-admin");
    expect(plan.worker.user).toBe("rakazo_credential_worker");
    expect(plan.migration.host).toBe(plan.worker.host);
    const opened: string[] = [];
    await attestCredentialWorker(migration, worker, ((config) => {
      opened.push(config.user);
      return {
        async connect() {},
        async query() {
          return {
            rows: [
              {
                ident: "1",
                db: "app",
                session_user: config.user,
                current_user: config.user,
              },
            ],
            rowCount: 1,
          };
        },
        async end() {},
      };
    }) as Parameters<typeof attestCredentialWorker>[2]);
    expect(opened).toEqual(["migration-admin", "rakazo_credential_worker"]);
  });
});

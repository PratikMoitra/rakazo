// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Offline only: socket, constructor, and engine spawn are denied. No database port is contacted.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { heldBackMigrations } from "./deferred-migrations.js";
import {
  OWNERSHIP_REFUSAL,
  publishFixtureHandle,
  registerFixtureAllocation,
  restoreEnv,
  revokeFixtureAllocation,
} from "./fixture-allocation.js";
import {
  assertFixtureDatabaseEnv,
  ENDPOINT_REFUSAL,
  fixtureConnectionPlan,
  fixtureEngineEnv,
  fixtureEngineUrl,
  openExplicitClient,
  PLAINTEXT_REFUSAL,
} from "./fixture-transport.js";
import { deployMigrations, provisionCredentialWorker, provisionRuntimeRole } from "./index.js";
import { acceptanceChannels } from "./owned-acceptance.js";

const counts = vi.hoisted(() => ({ clients: 0, pools: 0, spawns: 0, sockets: 0 }));

vi.mock("pg", () => ({
  Client: class {
    constructor() {
      counts.clients += 1;
    }
    connect() {
      return Promise.reject(new Error("client connect denied"));
    }
    end() {
      return Promise.resolve();
    }
    query() {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    on() {
      return this;
    }
  },
  Pool: class {
    constructor() {
      counts.pools += 1;
    }
    on() {
      return this;
    }
    connect() {
      return Promise.reject(new Error("pool connect denied"));
    }
    end() {
      return Promise.resolve();
    }
  },
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: () => {
      counts.spawns += 1;
      throw new Error("spawn denied");
    },
    spawn: () => {
      counts.spawns += 1;
      throw new Error("spawn denied");
    },
  };
});

const loopback = "postgres://fixture:secret@127.0.0.1:9/db";
const remote = "postgres://fixture:secret@evil.example/db";
const poisoned = {
  DATABASE_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
  DATABASE_MIGRATION_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
  DATABASE_WORKER_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
  REALTIME_DATABASE_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
  PGHOST: "203.0.113.10",
  PGPORT: "5432",
  PGUSER: "ambient",
  PGPASSWORD: "ambient-secret",
  PGDATABASE: "preserved",
  NODE_OPTIONS: "--require ./not-a-loader.js",
  PRISMA_SCHEMA_ENGINE_BINARY: "/tmp/not-an-engine",
};

describe("owned fixture transport refuses before I/O", () => {
  const originalConnect = Socket.prototype.connect;
  const previous: Record<string, string | undefined> = {};
  let root = "";
  let handle: ReturnType<typeof registerFixtureAllocation> | undefined;
  let release: () => void = () => undefined;

  beforeAll(() => {
    Socket.prototype.connect = function connect() {
      counts.sockets += 1;
      throw new Error("socket denied");
    } as Socket["connect"];
  });

  afterAll(() => {
    Socket.prototype.connect = originalConnect;
  });

  afterEach(() => {
    release();
    if (handle) revokeFixtureAllocation(handle);
    if (root) rmSync(root, { recursive: true, force: true });
    restoreEnv(previous);
    handle = undefined;
    root = "";
    counts.clients = 0;
    counts.pools = 0;
    counts.spawns = 0;
    counts.sockets = 0;
  });

  function poison() {
    for (const [key, value] of Object.entries(poisoned)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    previous.RAKAZO_DISPOSABLE_FIXTURE = process.env.RAKAZO_DISPOSABLE_FIXTURE;
    previous.RAKAZO_FIXTURE_HANDLE = process.env.RAKAZO_FIXTURE_HANDLE;
    previous.RAKAZO_FIXTURE_TOKEN = process.env.RAKAZO_FIXTURE_TOKEN;
    previous.RAKAZO_OWNED_FIXTURE_ID = process.env.RAKAZO_OWNED_FIXTURE_ID;
    process.env.RAKAZO_DISPOSABLE_FIXTURE = "1";
    delete process.env.RAKAZO_FIXTURE_HANDLE;
    delete process.env.RAKAZO_FIXTURE_TOKEN;
    delete process.env.RAKAZO_OWNED_FIXTURE_ID;
  }

  function own(input?: { host?: string; port?: number; database?: string; users?: string[] }) {
    if (handle) revokeFixtureAllocation(handle);
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(path.join(tmpdir(), "phase1-own-"));
    const data = path.join(root, "data");
    mkdirSync(data);
    handle = registerFixtureAllocation({
      host: input?.host ?? "127.0.0.1",
      port: input?.port ?? 9,
      database: input?.database ?? "db",
      users: input?.users ?? ["fixture", "rakazo_credential_worker"],
      dataDirectory: data,
      root,
    });
    release = publishFixtureHandle(handle);
  }

  function expectNoIo() {
    expect(counts.clients).toBe(0);
    expect(counts.pools).toBe(0);
    expect(counts.spawns).toBe(0);
    expect(counts.sockets).toBe(0);
  }

  it("rejects missing, forged, stale, and non-owned loopback targets before construction", async () => {
    poison();
    previous.PGSSLMODE = process.env.PGSSLMODE;
    previous.PGOPTIONS = process.env.PGOPTIONS;
    process.env.PGSSLMODE = "no-verify";
    process.env.PGOPTIONS = "-c statement_timeout=1";
    const opened = { count: 0 };
    const open = () => {
      opened.count += 1;
      throw new Error("constructed");
    };
    await expect(provisionRuntimeRole(loopback, loopback, open)).rejects.toThrow(/TLS mode/);
    delete process.env.PGSSLMODE;
    await expect(provisionRuntimeRole(loopback, loopback, open)).rejects.toThrow(/startup options/);
    delete process.env.PGOPTIONS;
    await expect(provisionRuntimeRole(loopback, loopback, open)).rejects.toThrow(OWNERSHIP_REFUSAL);
    await expect(
      provisionCredentialWorker(
        loopback,
        "postgres://rakazo_credential_worker:secret@127.0.0.1:9/db",
        open,
      ),
    ).rejects.toThrow(OWNERSHIP_REFUSAL);
    await expect(
      deployMigrations({ migrationUrl: loopback, dbPackageDir: tmpdir() }),
    ).rejects.toThrow(OWNERSHIP_REFUSAL);
    expect(() => acceptanceChannels()).toThrow(/external database url/);
    expect(() =>
      openExplicitClient({ host: "127.0.0.1", port: 0, user: "", database: "", password: "x" }),
    ).toThrow(ENDPOINT_REFUSAL);
    expect(opened.count).toBe(0);
    expectNoIo();
    expect(execFileSync).toBeTypeOf("function");
  });

  it("rejects a forged handle, a stale directory, and a mixed database", () => {
    poison();
    own();
    process.env.RAKAZO_FIXTURE_TOKEN = "forged";
    expect(() => fixtureConnectionPlan(loopback)).toThrow(OWNERSHIP_REFUSAL);
    process.env.RAKAZO_FIXTURE_TOKEN = handle!.token;
    process.env.RAKAZO_OWNED_FIXTURE_ID = "someone-elses-id";
    expect(() => fixtureConnectionPlan(loopback)).toThrow(OWNERSHIP_REFUSAL);
    process.env.RAKAZO_OWNED_FIXTURE_ID = handle!.id;
    expect(() => fixtureConnectionPlan("postgres://fixture:secret@127.0.0.1:9/other")).toThrow(
      OWNERSHIP_REFUSAL,
    );
    expect(() =>
      registerFixtureAllocation({
        host: "127.0.0.1",
        port: 9,
        database: "db",
        users: ["fixture"],
        dataDirectory: path.join(root, "data"),
        root,
      }),
    ).toThrow(/reused endpoint/);
    expect(() =>
      assertFixtureDatabaseEnv({
        DATABASE_URL: loopback,
        DATABASE_MIGRATION_URL: loopback,
        REALTIME_DATABASE_URL: loopback,
        DATABASE_WORKER_URL: " ",
      }),
    ).toThrow(/blank/);
    rmSync(path.join(root, "data"), { recursive: true, force: true });
    expect(() => fixtureConnectionPlan(loopback)).toThrow(/stale/);
    expectNoIo();
  });

  it("rejects remote and spoof hosts before construction", () => {
    poison();
    own();
    expect(() => fixtureConnectionPlan(remote)).toThrow(PLAINTEXT_REFUSAL);
    expect(() => fixtureConnectionPlan("postgres://fixture:secret@localhost:9/db")).toThrow(
      PLAINTEXT_REFUSAL,
    );
    expect(() => fixtureConnectionPlan("postgres://fixture:secret@127.0.0.2:9/db")).toThrow(
      PLAINTEXT_REFUSAL,
    );
    expectNoIo();
  });

  it("round-trips engine identity for IPv4, IPv6, percent fields, and the internal timeout", () => {
    poison();
    own({ host: "::1", port: 9, database: "a%41b", users: ["a@b"] });
    const ipv6 = fixtureEngineUrl("postgres://a%40b:p%2540ss@[::1]:9/a%2541b", 5000);
    expect(ipv6.startsWith("postgres://")).toBe(true);
    expect(ipv6).toContain("[::1]:9/");
    expect(ipv6).not.toContain("127.0.0.1");
    own({ host: "127.0.0.1", port: 9, database: "dummy", users: ["user"] });
    const ipv4 = fixtureEngineUrl("postgres://user:secret@127.0.0.1:9/dummy");
    expect(ipv4).toContain("@127.0.0.1:9/dummy");
    const env = fixtureEngineEnv(ipv4, { RAKAZO_MIGRATIONS_PATH: "/tmp/migrations" });
    expect(env.DATABASE_URL).toBe(ipv4);
    expect(env.PGHOST).toBeUndefined();
    expect(env.PGSSLMODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PRISMA_SCHEMA_ENGINE_BINARY).toBeUndefined();
    expect(() => fixtureEngineEnv(ipv4, { DATABASE_URL: remote })).toThrow(/protected override/);
    expect(() => fixtureEngineEnv(ipv4, { PGHOST: "203.0.113.10" })).toThrow(/protected override/);
    expectNoIo();
  });

  it("uses an injected transport for nested credential preflight", async () => {
    poison();
    own({ users: ["fixture", "rakazo_credential_worker"] });
    const opened: string[] = [];
    const open = (url: string) => {
      opened.push(url);
      return {
        async connect() {},
        async end() {},
        async query() {
          return { rows: [], rowCount: 0 };
        },
      };
    };
    await expect(
      provisionCredentialWorker(
        loopback,
        "postgres://rakazo_credential_worker:secret@127.0.0.1:9/db",
        open as never,
      ),
    ).rejects.toThrow();
    expect(opened.length).toBeGreaterThan(0);
    expectNoIo();
  });

  it("does not spawn the migration engine for an unowned url", async () => {
    poison();
    const directory = mkdtempSync(path.join(tmpdir(), "phase1-hold-"));
    const migration = path.join(directory, "20260101000000_hold");
    mkdirSync(migration);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(migration, "migration.sql"), "-- deferred\nSELECT 1;\n");
    await expect(heldBackMigrations(loopback, directory)).rejects.toThrow(OWNERSHIP_REFUSAL);
    rmSync(directory, { recursive: true, force: true });
    expect(() => assertFixtureDatabaseEnv(process.env)).toThrow(PLAINTEXT_REFUSAL);
    expectNoIo();
  });
});

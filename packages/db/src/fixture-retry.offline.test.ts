// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Fault-injects the migration retry. No database server and no native engine.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterEach, expect, it } from "vitest";
import { deployMigrations } from "./deferred-migrations.js";
import {
  beginFixtureClose,
  publishFixtureHandle,
  registerFixtureAllocation,
  restoreEnv,
  revokeFixtureAllocation,
} from "./fixture-allocation.js";

const original = Client.prototype.connect;
afterEach(() => {
  Client.prototype.connect = original;
});

function owned(port: number) {
  const root = mkdtempSync(path.join(tmpdir(), "phase1-retry-"));
  const data = path.join(root, "data");
  mkdirSync(data);
  const handle = registerFixtureAllocation({
    host: "127.0.0.1",
    port,
    database: "db",
    users: ["fixture"],
    dataDirectory: data,
    root,
  });
  const previous = {
    RAKAZO_DISPOSABLE_FIXTURE: process.env.RAKAZO_DISPOSABLE_FIXTURE,
    RAKAZO_FIXTURE_HANDLE: process.env.RAKAZO_FIXTURE_HANDLE,
    RAKAZO_FIXTURE_TOKEN: process.env.RAKAZO_FIXTURE_TOKEN,
    RAKAZO_OWNED_FIXTURE_ID: process.env.RAKAZO_OWNED_FIXTURE_ID,
  };
  const release = publishFixtureHandle(handle);
  return { root, data, handle, release, previous };
}

function migrationsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "phase1-migrations-"));
  const name = path.join(dir, "20260101000000_lock");
  mkdirSync(name);
  writeFileSync(path.join(name, "migration.sql"), "SELECT 1;\n");
  return dir;
}

it("does not delegate a retry after the captured allocation is closed", async () => {
  const first = owned(9);
  const dir = migrationsDir();
  let opens = 0;
  let extra: ReturnType<typeof owned> | undefined;
  Client.prototype.connect = function connect(this: Client, callback?: (error?: Error) => void) {
    opens += 1;
    this.query = (async (sql: string) => {
      if (String(sql).includes("finished_at IS NULL")) {
        beginFixtureClose(first.handle);
        extra = owned(9);
        return {
          rows: [{ id: "1", migration_name: "20260101000000_lock", logs: "55P03" }],
        };
      }
      if (String(sql).includes("to_regclass")) return { rows: [{ exists: false }] };
      return { rows: [], rowCount: 1 };
    }) as Client["query"];
    this.end = (async () => undefined) as Client["end"];
    if (typeof callback === "function") {
      queueMicrotask(() => callback());
      return;
    }
    return Promise.resolve();
  } as Client["connect"];
  const spawned: string[] = [];
  await expect(
    deployMigrations({
      migrationUrl: "postgres://fixture:secret@127.0.0.1:9/db",
      dbPackageDir: first.root,
      migrationsDir: dir,
      lockRetryDelaysMs: [15],
      spawn: () => {
        spawned.push(process.env.RAKAZO_FIXTURE_HANDLE ?? "");
        if (spawned.length === 1) throw new Error("lock lost");
        throw new Error("second delegation");
      },
    }),
  ).rejects.toThrow(/owned fixture|stale|lock lost/);
  expect(spawned).toHaveLength(1);
  expect(opens).toBeGreaterThan(0);
  extra?.release();
  if (extra) {
    revokeFixtureAllocation(extra.handle);
    rmSync(extra.root, { recursive: true, force: true });
  }
  revokeFixtureAllocation(first.handle);
  first.release();
  restoreEnv(first.previous);
  rmSync(first.root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

it("retries a lock conflict while the same allocation stays open", async () => {
  const first = owned(9);
  const dir = migrationsDir();
  Client.prototype.connect = function connect(this: Client, callback?: (error?: Error) => void) {
    this.query = (async (sql: string) => {
      if (String(sql).includes("finished_at IS NULL")) {
        return {
          rows: [{ id: "1", migration_name: "20260101000000_lock", logs: "40P01" }],
        };
      }
      if (String(sql).includes("to_regclass")) return { rows: [{ exists: false }] };
      return { rows: [], rowCount: 1 };
    }) as Client["query"];
    this.end = (async () => undefined) as Client["end"];
    if (typeof callback === "function") {
      queueMicrotask(() => callback());
      return;
    }
    return Promise.resolve();
  } as Client["connect"];
  let calls = 0;
  await deployMigrations({
    migrationUrl: "postgres://fixture:secret@127.0.0.1:9/db",
    dbPackageDir: first.root,
    migrationsDir: dir,
    lockRetryDelaysMs: [10],
    spawn: (_command, _args, options) => {
      calls += 1;
      expect(options.env.RAKAZO_FIXTURE_HANDLE).toBe(first.handle.path);
      expect(options.env.RAKAZO_FIXTURE_TOKEN).toBe(first.handle.token);
      if (calls === 1) throw new Error("lock lost");
    },
  });
  expect(calls).toBe(2);
  first.release();
  revokeFixtureAllocation(first.handle);
  restoreEnv(first.previous);
  rmSync(first.root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

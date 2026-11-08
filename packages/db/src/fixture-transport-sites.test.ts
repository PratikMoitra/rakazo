// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { heldBackMigrations } from "./deferred-migrations.js";
import {
  assertApprovedPool,
  assertFixtureDatabaseEnv,
  openFixturePool,
  PLAINTEXT_REFUSAL,
} from "./fixture-transport.js";
import {
  deployMigrations,
  installQueueBoundary,
  preflightQueueBoundary,
  provisionCredentialWorker,
  provisionRuntimeRole,
  restoreRuntimeQueueGrants,
} from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCAN_ROOTS = ["packages/db/src", "packages/adapters/src", "apps/api/src", "apps/worker/src"];
const CONSTRUCTOR_FILE = "packages/db/src/fixture-transport.ts";
const remote = "postgres://fixture:fixture@evil.example/db";
const loopback = "postgres://fixture:fixture@127.0.0.1:9/db";

function filesUnder(root: string): string[] {
  const absolute = path.join(repoRoot, root);
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "generated" || entry.name === "dist") continue;
        visit(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(path.relative(repoRoot, full));
      }
    }
  };
  visit(absolute);
  return found;
}

describe("fixture transport use sites", () => {
  const previous = process.env.RAKAZO_DISPOSABLE_FIXTURE;
  afterEach(() => {
    if (previous === undefined) delete process.env.RAKAZO_DISPOSABLE_FIXTURE;
    else process.env.RAKAZO_DISPOSABLE_FIXTURE = previous;
  });

  it("allows pg constructors only in the fixture transport, inside the scanned trees", () => {
    const offenders: string[] = [];
    const engine: string[] = [];
    const graphile: string[] = [];
    for (const file of SCAN_ROOTS.flatMap(filesUnder)) {
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      const importsPg = /from\s+["']pg["']/.test(source);
      if (importsPg && /new\s+(?:Client|Pool)\s*\(/.test(source) && file !== CONSTRUCTOR_FILE) {
        offenders.push(file);
      }
      if (source.includes("makeWorkerUtils({ connectionString")) graphile.push(file);
      if (source.includes('prisma", "migrate", "deploy"') && !source.includes("fixtureEngineUrl")) {
        engine.push(file);
      }
    }
    expect(offenders).toEqual([]);
    expect(graphile).toEqual([]);
    expect(engine).toEqual([]);
    expect(filesUnder("packages/db/src")).toContain(CONSTRUCTOR_FILE);
    const delegated = [
      ["packages/db/package.json", "fixture-migrate-cli"],
      ["packages/db/prisma.config.ts", "unowned database url"],
      ["packages/db/src/deferred-migrations.ts", "pinnedPrismaCli"],
      ["packages/testkit/src/cli/postgres.ts", "not a phase1 fixture allocation"],
    ] as const;
    for (const [file, marker] of delegated) {
      expect(readFileSync(path.join(repoRoot, file), "utf8")).toContain(marker);
    }
  });

  it("does not construct a client for a remote url on each entry", async () => {
    process.env.RAKAZO_DISPOSABLE_FIXTURE = "1";
    let opened = 0;
    const open = () => {
      opened += 1;
      throw new Error("constructed");
    };
    const worker = "postgres://rakazo_credential_worker:fixture@evil.example/db";
    const workerLoop = "postgres://rakazo_credential_worker:fixture@127.0.0.1:9/db";
    await expect(preflightQueueBoundary(remote, open)).rejects.toThrow(PLAINTEXT_REFUSAL);
    await expect(installQueueBoundary(remote, open)).rejects.toThrow(PLAINTEXT_REFUSAL);
    await expect(provisionCredentialWorker(remote, workerLoop, open)).rejects.toThrow(
      /owned fixture|literal loopback/,
    );
    await expect(provisionCredentialWorker(loopback, worker, open)).rejects.toThrow(
      /owned fixture|literal loopback/,
    );
    await expect(provisionRuntimeRole(remote, loopback, open)).rejects.toThrow(
      /owned fixture|literal loopback/,
    );
    await expect(provisionRuntimeRole(loopback, remote, open)).rejects.toThrow(
      /owned fixture|literal loopback/,
    );
    await expect(restoreRuntimeQueueGrants(remote, open)).rejects.toThrow(PLAINTEXT_REFUSAL);
    const { createPool } = await import("./client.js");
    expect(() => createPool(remote)).toThrow(PLAINTEXT_REFUSAL);
    await expect(
      deployMigrations({ migrationUrl: remote, dbPackageDir: repoRoot }),
    ).rejects.toThrow(PLAINTEXT_REFUSAL);
    expect(opened).toBe(0);
  });

  it("rejects each database channel and accepts an unset worker url without opening a pool", () => {
    process.env.RAKAZO_DISPOSABLE_FIXTURE = "1";
    const channels = {
      DATABASE_URL: loopback,
      DATABASE_MIGRATION_URL: loopback,
      REALTIME_DATABASE_URL: loopback,
    };
    expect(() => assertFixtureDatabaseEnv(channels)).toThrow(/owned fixture/);
    expect(() => assertFixtureDatabaseEnv({ ...channels, DATABASE_URL: remote })).toThrow(
      PLAINTEXT_REFUSAL,
    );
    expect(() => assertFixtureDatabaseEnv({ ...channels, DATABASE_MIGRATION_URL: remote })).toThrow(
      /owned fixture/,
    );
    expect(() => assertFixtureDatabaseEnv({ ...channels, REALTIME_DATABASE_URL: remote })).toThrow(
      /owned fixture/,
    );
    expect(() => assertFixtureDatabaseEnv({ ...channels, DATABASE_WORKER_URL: remote })).toThrow(
      /owned fixture/,
    );
    expect(() => assertFixtureDatabaseEnv({ ...channels, DATABASE_WORKER_URL: " " })).toThrow(
      /owned fixture/,
    );
    delete process.env.RAKAZO_DISPOSABLE_FIXTURE;
    expect(() => assertFixtureDatabaseEnv(channels)).toThrow(PLAINTEXT_REFUSAL);
  });

  it("refuses a pool that the fixture transport did not approve", () => {
    expect(() => assertApprovedPool({} as never)).toThrow(/disposable fixture transport/);
    expect(() => openFixturePool(loopback)).toThrow(/owned fixture|literal loopback/);
  });

  it("does not open a client while reading a deferred migration from a remote url", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "phase1-deferred-"));
    const migration = path.join(directory, "20260101000000_hold");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(migration);
    writeFileSync(path.join(migration, "migration.sql"), "-- deferred\nSELECT 1;\n");
    await expect(heldBackMigrations(remote, directory)).rejects.toThrow(PLAINTEXT_REFUSAL);
    rmSync(directory, { recursive: true, force: true });
  });
});

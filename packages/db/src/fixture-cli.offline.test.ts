// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Subprocess smokes for the package migrate scripts and Prisma config. No engine is started.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { registerFixtureAllocation, revokeFixtureAllocation } from "./fixture-allocation.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(repoRoot, "node_modules/.bin/tsx");

function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(tsx, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...extra,
  };
}

it("refuses package migrate and migrate dev for the right reason", async () => {
  const missing = await run(
    ["packages/db/src/fixture-migrate-cli.ts"],
    baseEnv({
      DATABASE_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
      RAKAZO_FIXTURE_HANDLE: "/tmp/phase1-not-a-handle.json",
    }),
  );
  expect(missing.code).toBe(1);
  expect(missing.output).toContain("database target is not an owned fixture allocation");
  expect(missing.output).not.toContain("ERR_MODULE_NOT_FOUND");
  expect(missing.output).not.toContain("Cannot find module");

  const dev = await run(
    ["packages/db/src/fixture-migrate-cli.ts", "--dev"],
    baseEnv({ DATABASE_URL: "postgres://ambient:ambient@203.0.113.10/preserved" }),
  );
  expect(dev.code).toBe(1);
  expect(dev.output).toContain("prisma migrate dev is disabled in the fixture workflow");
  expect(dev.output).not.toContain("ERR_MODULE_NOT_FOUND");
});

it("accepts owned metadata without starting the migration engine", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "phase1-cli-"));
  const data = path.join(root, "data");
  mkdirSync(data);
  const handle = registerFixtureAllocation({
    host: "127.0.0.1",
    port: 9,
    database: "db",
    users: ["fixture"],
    dataDirectory: data,
    root,
  });
  const ran = await run(
    ["packages/db/src/fixture-migrate-cli.ts"],
    baseEnv({
      RAKAZO_DISPOSABLE_FIXTURE: "1",
      RAKAZO_FIXTURE_HANDLE: handle.path,
      RAKAZO_FIXTURE_TOKEN: handle.token,
      RAKAZO_OWNED_FIXTURE_ID: handle.id,
      DATABASE_MIGRATION_URL: "postgres://fixture:secret@127.0.0.1:9/db",
      RAKAZO_FIXTURE_ENGINE_SMOKE: "1",
      PRISMA_SCHEMA_ENGINE_BINARY: "/tmp/not-an-engine",
    }),
  );
  revokeFixtureAllocation(handle);
  rmSync(root, { recursive: true, force: true });
  expect(ran.code).toBe(0);
  expect(ran.output).toContain("fixture migration delegation accepted");
  expect(ran.output).not.toContain("ERR_MODULE_NOT_FOUND");
  expect(ran.output).not.toContain("not-an-engine");
});

it("rejects a raw Prisma config that only has a fake handle", async () => {
  const loader = path.join(repoRoot, "packages/db/fixture-config-smoke.mts");
  const fake = await run(
    [loader],
    baseEnv({
      RAKAZO_DISPOSABLE_FIXTURE: "1",
      RAKAZO_FIXTURE_HANDLE: "/tmp/phase1-missing-allocation.json",
      DATABASE_MIGRATION_URL: "postgres://fixture:secret@127.0.0.1:9/db",
      DATABASE_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
    }),
  );
  expect(fake.code).toBe(1);
  expect(fake.output).toContain("database target is not an owned fixture allocation");

  const ambient = await run(
    [loader],
    baseEnv({
      DATABASE_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
    }),
  );
  expect(ambient.code).toBe(1);
  expect(ambient.output).toContain("database target is not an owned fixture allocation");

  const generate = await run([loader], baseEnv({ RAKAZO_CONFIG_ARGV: "generate" }));
  expect(generate.code).toBe(0);

  const operand = await run(
    [loader],
    baseEnv({
      RAKAZO_CONFIG_ARGV: "migrate resolve --applied generate",
      DATABASE_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
      DATABASE_MIGRATION_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
    }),
  );
  expect(operand.code).toBe(1);
  expect(operand.output).toContain("database target is not an owned fixture allocation");

  const named = await run(
    [loader],
    baseEnv({
      RAKAZO_CONFIG_ARGV: "migrate dev --name generate",
      DATABASE_MIGRATION_URL:
        "postgres://fixture:secret@203.0.113.10:6543/db?host=127.0.0.1&port=9",
      RAKAZO_DISPOSABLE_FIXTURE: "1",
    }),
  );
  expect(named.code).toBe(1);
  expect(named.output).not.toContain("fixture migration delegation accepted");
});

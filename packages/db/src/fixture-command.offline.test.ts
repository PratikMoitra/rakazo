// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Classifies Prisma argv and checks the engine URL the config will accept. No engine is started.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  captureAllocationAuthority,
  publishFixtureHandle,
  registerFixtureAllocation,
  revokeFixtureAllocation,
} from "./fixture-allocation.js";
import { isNonconnectingGenerate } from "./fixture-command.js";
import {
  canonicalEngineInput,
  ENDPOINT_REFUSAL,
  fixtureEngineEnv,
  fixtureEngineUrl,
} from "./fixture-transport.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(repoRoot, "node_modules/.bin/tsx");
const loader = "packages/db/fixture-config-smoke.mts";

function command(argv: readonly string[]): boolean {
  return isNonconnectingGenerate(["node", "prisma", ...argv]);
}

it("recognizes only an unambiguous generate command", () => {
  expect(command(["--telemetry-information", "generate", "migrate", "deploy"])).toBe(false);
  expect(command(["--telemetry-information=generate", "migrate", "deploy"])).toBe(false);
  expect(command(["--config", "generate", "migrate", "deploy"])).toBe(false);
  expect(command(["--config=prisma.config.ts", "migrate", "deploy"])).toBe(false);
  expect(command(["--telemetry-information"])).toBe(false);
  expect(command(["--config"])).toBe(false);
  expect(command(["--telemetry-information="])).toBe(false);
  expect(command(["--not-a-flag", "generate"])).toBe(false);
  expect(command(["--json=true", "generate"])).toBe(false);
  expect(command(["--schema", "schema.prisma", "generate"])).toBe(false);
  expect(command(["migrate", "resolve", "--applied", "generate"])).toBe(false);
  expect(command(["migrate", "dev", "--name", "generate"])).toBe(false);
  expect(command(["--help"])).toBe(false);
  expect(command(["--version", "generate"])).toBe(false);
  expect(
    isNonconnectingGenerate([
      "node",
      "/opt/prisma/build/index.js",
      "--telemetry-information",
      "generate",
      "migrate",
      "deploy",
    ]),
  ).toBe(false);

  expect(command(["generate"])).toBe(true);
  expect(command(["generate", "--sql"])).toBe(true);
  expect(command(["--json", "generate"])).toBe(true);
  expect(command(["--preview-feature", "generate"])).toBe(true);
  expect(command(["--config=prisma.config.ts", "generate"])).toBe(true);
  expect(command(["--early-access", "--config", "prisma.config.ts", "generate"])).toBe(true);
  expect(isNonconnectingGenerate(["node", "/opt/prisma/build/index.js", "generate"])).toBe(true);
});

function run(env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(tsx, [loader], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
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

it("refuses a string-flag value named generate before any engine", async () => {
  const refused = await run({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RAKAZO_CONFIG_ARGV: "--telemetry-information generate migrate deploy",
    DATABASE_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
    DATABASE_MIGRATION_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
  });
  expect(refused.code).toBe(1);
  expect(refused.output).toContain("database target is not an owned fixture allocation");

  const unknown = await run({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RAKAZO_CONFIG_ARGV: "--not-a-flag generate",
    DATABASE_MIGRATION_URL: "postgres://ambient:ambient@203.0.113.10/preserved",
  });
  expect(unknown.code).toBe(1);
  expect(unknown.output).toContain("database target is not an owned fixture allocation");

  const generate = await run({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RAKAZO_CONFIG_ARGV: "--config=prisma.config.ts generate",
  });
  expect(generate.code).toBe(0);
});

it("accepts the deployer's lock-timeout URL in the config that child would load", async () => {
  const cases = [
    {
      host: "127.0.0.1",
      raw: "postgres://fixture:secret@127.0.0.1:9/db",
    },
    {
      host: "::1",
      raw: "postgres://a%40b:p%2540ss@[::1]:9/a%2541b",
    },
  ];
  for (const item of cases) {
    const root = mkdtempSync(path.join(tmpdir(), "phase1-engine-url-"));
    const data = path.join(root, "data");
    mkdirSync(data);
    const handle = registerFixtureAllocation({
      host: item.host,
      port: 9,
      database: item.host === "::1" ? "a%41b" : "db",
      users: [item.host === "::1" ? "a@b" : "fixture"],
      dataDirectory: data,
      root,
    });
    const release = publishFixtureHandle(handle);
    const authority = captureAllocationAuthority();
    const engineUrl = fixtureEngineUrl(item.raw, 5_000, authority);
    const childEnv = fixtureEngineEnv(engineUrl, {}, authority);
    try {
      const loaded = await run({
        ...childEnv,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RAKAZO_CONFIG_ARGV: "migrate deploy",
        RAKAZO_CHECK_ENGINE_URL: "1",
      });
      expect(loaded.code).toBe(0);
      expect(loaded.output).toContain("engine-url-match");
      expect(engineUrl).toContain("lock_timeout%3D5000");
    } finally {
      release();
      revokeFixtureAllocation(handle);
      rmSync(root, { recursive: true, force: true });
    }
  }

  expect(() =>
    canonicalEngineInput(
      "postgres://fixture:secret@127.0.0.1:9/db?options=-c%20lock_timeout%3D5000&options=-c%20lock_timeout%3D5000",
    ),
  ).toThrow(ENDPOINT_REFUSAL);
  expect(() =>
    canonicalEngineInput(
      "postgres://fixture:secret@127.0.0.1:9/db?options=-c%20statement_timeout%3D5000",
    ),
  ).toThrow(ENDPOINT_REFUSAL);
  expect(() =>
    canonicalEngineInput(
      "postgres://fixture:secret@203.0.113.10:6543/db?host=127.0.0.1&port=9&options=-c%20lock_timeout%3D5000",
    ),
  ).toThrow(ENDPOINT_REFUSAL);
  expect(() =>
    canonicalEngineInput("postgres://fixture:secret@127.0.0.1:9/db?options=-c%20lock_timeout%3D0"),
  ).toThrow(ENDPOINT_REFUSAL);
});

// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rejectPhase1FixtureFlags } from "./reject-phase1-fixtures.js";

it("rejects fixture flags for every NODE_ENV value", () => {
  expect(() =>
    rejectPhase1FixtureFlags({
      NODE_ENV: "production",
      PHASE1_DUMMY_SECRET_STORE: "/tmp/phase1-not-written",
    }),
  ).toThrow(/phase1 fixture flags are not accepted/);
  expect(() =>
    rejectPhase1FixtureFlags({ NODE_ENV: "test", PHASE1_DUMMY_CRASH_AFTER_DELETE: "1" }),
  ).toThrow(/phase1 fixture flags are not accepted/);
  expect(() =>
    rejectPhase1FixtureFlags({ NODE_ENV: "production", PHASE1_DUMMY_SECRET_STORE: " " }),
  ).not.toThrow();
});

it("keeps the dummy store out of the production worker bundle", async () => {
  const secretStore = await readFile(new URL("./secret-store.ts", import.meta.url), "utf8");
  const entry = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  expect(secretStore).not.toContain("PHASE1_DUMMY");
  expect(secretStore).not.toContain("phase1FixtureSecretStore");
  expect(entry).not.toContain("phase1-fixture-secret-store");
  expect(entry).not.toContain("process.exit(75)");
  const workerRoot = new URL("..", import.meta.url).pathname;
  const outfile = join(workerRoot, "dist/index.js");
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "node",
        ["../../scripts/build-server.mjs", "src/index.ts"],
        { cwd: workerRoot },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr || stdout || error.message));
          else resolve();
        },
      );
    });
    const bundled = await readFile(outfile, "utf8");
    expect(bundled).not.toContain("phase1-dummy");
    expect(bundled).not.toContain("phase1FixtureSecretStore");
    expect(bundled).not.toContain("crashAfterDelete");
    expect(bundled).not.toContain("process.exit(75)");
    expect(bundled).toContain("phase1 fixture flags are not accepted");
  } finally {
    await rm(join(workerRoot, "dist"), { recursive: true, force: true });
  }
});

it("rejects fixture flags at production startup before creating a dummy file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase1-flag-"));
  const file = join(dir, "secrets.json");
  const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn("/workspace/node_modules/.bin/tsx", ["src/index.ts"], {
      cwd: "/workspace/apps/worker",
      env: {
        ...process.env,
        NODE_ENV: "production",
        PHASE1_DUMMY_SECRET_STORE: file,
        PHASE1_DUMMY_CRASH_AFTER_DELETE: "1",
        DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/none",
      },
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("phase1 fixture flags are not accepted");
  await expect(readFile(file, "utf8")).rejects.toThrow();
  await rm(dir, { recursive: true, force: true });
});

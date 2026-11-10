// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rejectPhase1FixtureFlags } from "./reject-phase1-fixtures.js";

function runBuilt(script: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--enable-source-maps", script], {
      cwd: "/workspace",
      env,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

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
    expect(bundled).not.toContain("import.meta.resolve");
    const ran = await runBuilt(outfile, {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      PHASE1_DUMMY_SECRET_STORE: join(workerRoot, "dist/not-created.json"),
      DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/none",
      REALTIME_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/none",
    });
    expect(ran.output).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(ran.output).toContain("phase1 fixture flags are not accepted");
    expect(ran.code).not.toBe(0);
  } finally {
    await rm(join(workerRoot, "dist"), { recursive: true, force: true });
  }
});

it("loads the built API entry without a missing pg module", async () => {
  const apiRoot = new URL("../../api/", import.meta.url).pathname;
  const outfile = join(apiRoot, "dist/index.js");
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "node",
        ["../../scripts/build-server.mjs", "src/index.ts"],
        { cwd: apiRoot },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr || stdout || error.message));
          else resolve();
        },
      );
    });
    const ran = await runBuilt(outfile, {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      PHASE1_DUMMY_SECRET_STORE: join(apiRoot, "dist/not-created.json"),
    });
    expect(ran.code).toBe(1);
    expect(ran.output).toContain("phase1 fixture flags are not accepted");
    expect(ran.output).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(ran.output).not.toContain("ECONNREFUSED");
  } finally {
    await rm(join(apiRoot, "dist"), { recursive: true, force: true });
  }
});

it("rejects fixture flags at production startup before creating a dummy file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase1-flag-"));
  const file = join(dir, "secrets.json");
  const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn("/workspace/node_modules/.bin/tsx", ["src/index.ts"], {
      cwd: "/workspace/apps/worker",
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "production",
        PHASE1_DUMMY_SECRET_STORE: file,
        PHASE1_DUMMY_CRASH_AFTER_DELETE: "1",
        DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/none",
        REALTIME_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/none",
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

it("keeps fixture sources out of deployment copy contexts", async () => {
  const root = new URL("../../../", import.meta.url);
  const ignore = await readFile(new URL(".dockerignore", root), "utf8");
  const workerPackage = await readFile(new URL("apps/worker/package.json", root), "utf8");
  for (const name of [
    "apps/worker/src/phase1-fixture-secret-store.ts",
    "apps/worker/src/phase1-cleanup-fixture-main.ts",
    "apps/api/src/phase1-fixture-cluster.ts",
    "apps/api/src/phase1-cleanup-once.ts",
    "**/*.test.ts",
  ]) {
    expect(ignore).toContain(name);
  }
  const ignored = ignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  expect(ignored).not.toContain("apps/worker/src/reject-phase1-fixtures.ts");
  expect(workerPackage).toContain(
    '"build": "node ../../scripts/build-server.mjs src/index.ts src/health-check.ts"',
  );
  for (const dockerfile of [
    "infra/compose/Dockerfile",
    "infra/railway/Dockerfile",
    "infra/compose/Dockerfile.topology",
  ]) {
    const source = await readFile(new URL(dockerfile, root), "utf8");
    expect(source).toContain("COPY");
    expect(source).not.toContain("phase1-cleanup-fixture-main");
  }
  const preview = await readFile(new URL("infra/preview/Dockerfile", root), "utf8");
  expect(preview.includes(`FROM ${"$"}{SERVER_IMAGE}`)).toBe(true);
  expect(preview).not.toContain("COPY --chmod=755 . .");
});

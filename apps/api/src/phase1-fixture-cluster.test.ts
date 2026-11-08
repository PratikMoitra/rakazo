// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixtureConnectionPlan,
  publishFixtureHandle,
  registerFixtureAllocation,
  restoreEnv,
} from "@rakazo/db";
import { expect, it } from "vitest";
import type { FixtureCommandResult } from "./phase1-fixture-cluster.js";
import {
  cleanupFixtureDataDirectory,
  createFixtureStopController,
  startFixtureCluster,
} from "./phase1-fixture-cluster.js";

function command(result: FixtureCommandResult) {
  return async () => result;
}

it("stops a server left behind by a rejected start before deleting its data", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase1-cluster-test-"));
  const removed: string[] = [];
  const calls: string[] = [];
  let running = false;
  await expect(
    startFixtureCluster({
      directory: root,
      remove: async (path) => {
        removed.push(path);
      },
      run: async (_command, args) => {
        calls.push(args[args.length - 1] ?? "");
        if (args.includes("initdb")) return { code: 0, stdout: "", stderr: "" };
        if (args.includes("start")) {
          running = true;
          return { code: 1, stdout: "", stderr: "timed out" };
        }
        if (args.includes("stop")) {
          running = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args.includes("status")) return { code: running ? 0 : 3, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  ).rejects.toThrow(/timed out/);
  expect(calls).toContain("stop");
  expect(calls).toContain("status");
  expect(removed).toEqual([root]);
  await rm(root, { recursive: true, force: true });
});

it("preserves the data directory when server status is unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase1-cluster-test-"));
  const removed: string[] = [];
  await expect(
    cleanupFixtureDataDirectory({
      data: join(root, "data"),
      root,
      startAttempted: true,
      remove: async (path) => {
        removed.push(path);
      },
      run: command({ code: 1, stdout: "", stderr: "status unavailable" }),
    }),
  ).rejects.toThrow(/stop uncertain/);
  expect(removed).toEqual([]);
  await rm(root, { recursive: true, force: true });
});

it("preserves the data directory when stop leaves the server running", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase1-cluster-test-"));
  const removed: string[] = [];
  await expect(
    cleanupFixtureDataDirectory({
      data: join(root, "data"),
      root,
      startAttempted: true,
      remove: async (path) => {
        removed.push(path);
      },
      run: async (_command, args) => {
        if (args.includes("stop")) return { code: 1, stdout: "", stderr: "stop failed" };
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  ).rejects.toThrow(/stop uncertain/);
  expect(removed).toEqual([]);
  await rm(root, { recursive: true, force: true });
});

it("drops allocation authority when stop starts and does not treat status 4 as stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase1-stop-"));
  const data = join(root, "data");
  mkdirSync(data);
  const handle = registerFixtureAllocation({
    host: "127.0.0.1",
    port: 9,
    database: "postgres",
    users: ["fixture_admin"],
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
  const removed: string[] = [];
  let statusCode = 4;
  const controller = createFixtureStopController({
    handle,
    data,
    root,
    remove: async (path) => {
      removed.push(path);
      throw new Error("remove failed");
    },
    run: async (_command, args) => {
      if (args.includes("status")) return { code: statusCode, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await expect(controller.stop()).rejects.toThrow(/status exit 4/);
  expect(removed).toEqual([]);
  expect(() =>
    fixtureConnectionPlan("postgres://fixture_admin:secret@127.0.0.1:9/postgres"),
  ).toThrow(/owned fixture/);
  await expect(controller.stop()).rejects.toThrow(/status exit 4/);
  statusCode = 3;
  await expect(controller.stop()).rejects.toThrow(/remove failed/);
  expect(removed).toEqual([root]);
  await expect(controller.stop()).rejects.toThrow(/remove failed/);
  expect(removed).toEqual([root, root]);
  release();
  restoreEnv(previous);
  await rm(root, { recursive: true, force: true });
});

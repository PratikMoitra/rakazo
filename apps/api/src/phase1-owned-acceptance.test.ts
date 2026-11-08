// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { restoreEnv } from "@rakazo/db";
import { expect, it } from "vitest";
import {
  allocateAll,
  ownedAcceptanceEnv,
  runOwnedProcess,
  stopAll,
} from "./phase1-owned-acceptance.js";

const handle = { id: "allocation-id", token: "token", path: "/tmp/phase1-allocation.json" };

it("derives acceptance channels from the allocation and restores every env key", () => {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL,
    PGSSLMODE: process.env.PGSSLMODE,
  };
  process.env.DATABASE_URL = "postgres://ambient:ambient@example/db";
  process.env.DATABASE_MIGRATION_URL = "postgres://ambient:ambient@example/db";
  process.env.PGSSLMODE = "no-verify";
  try {
    const admin = new URL("postgres://fixture_admin:secret@127.0.0.1:9/postgres");
    const env = ownedAcceptanceEnv(admin, handle);
    expect(env.DATABASE_URL).not.toContain("example");
    expect(env.DATABASE_MIGRATION_URL).not.toContain("example");
    expect(new URL(env.DATABASE_URL!).port).toBe("9");
    expect(new URL(env.DATABASE_MIGRATION_URL!).port).toBe("9");
    expect(new URL(env.DATABASE_URL!).username).toBe("rakazo_phase1_runtime");
    expect(new URL(env.DATABASE_MIGRATION_URL!).username).toBe("fixture_admin");
    expect(env.RAKAZO_OWNED_FIXTURE_ID).toBe(handle.id);
    expect(env.RAKAZO_FIXTURE_HANDLE).toBe(handle.path);
    expect(env.RAKAZO_FIXTURE_TOKEN).toBe(handle.token);
    expect(env.PGSSLMODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  } finally {
    restoreEnv(previous);
  }
  expect(process.env.DATABASE_URL).toBe(previous.DATABASE_URL);
  expect(process.env.DATABASE_MIGRATION_URL).toBe(previous.DATABASE_MIGRATION_URL);
  expect(process.env.PGSSLMODE).toBe(previous.PGSSLMODE);
});

it("stops every successful allocation when a later one fails", async () => {
  const stopped: string[] = [];
  const errors: unknown[] = [];
  await expect(
    allocateAll([
      async () => ({ stop: async () => void stopped.push("first") }),
      async () => {
        throw new Error("second failed");
      },
    ]),
  ).rejects.toThrow(/fixture allocation failed/);
  expect(stopped).toEqual(["first"]);
  await expect(
    stopAll([
      async () => {
        throw new Error("stop-a");
      },
      async () => {
        throw new Error("stop-b");
      },
    ]),
  ).rejects.toThrow(/fixture stop failed/);
  try {
    await stopAll([
      async () => {
        throw new Error("stop-a");
      },
      async () => {
        throw new Error("stop-b");
      },
    ]);
  } catch (error) {
    errors.push(error);
  }
  expect(errors[0]).toBeInstanceOf(AggregateError);
  expect((errors[0] as AggregateError).errors).toHaveLength(2);
});

it("kills an owned child on spawn failure and timeout before the caller continues", async () => {
  const signals: number[] = [];
  const failed = runOwnedProcess(
    "missing",
    [],
    {},
    {
      spawn: () => {
        throw new Error("spawn failed");
      },
    },
  );
  const spawnResult = await failed.result;
  expect(spawnResult.error?.message).toBe("spawn failed");
  await failed.killAndWait();

  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: 424242 });
  child.kill = () => {
    child.emit("close", null);
    return true;
  };
  const hanging = runOwnedProcess(
    "sleep",
    [],
    {},
    {
      timeoutMs: 20,
      signalProcess: (pid) => {
        signals.push(pid);
        child.emit("close", null);
      },
      spawn: () => child,
    },
  );
  const timed = await hanging.result;
  expect(timed.error?.message).toMatch(/timed out/);
  expect(signals.some((pid) => Math.abs(pid) === 424242)).toBe(true);
  await hanging.killAndWait();
});

it("signals a live child after error and waits for close", async () => {
  const signals: number[] = [];
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: 515151 });
  child.kill = () => true;
  const owned = runOwnedProcess(
    "sleep",
    [],
    {},
    {
      closeWaitMs: 50,
      signalProcess: (pid) => {
        signals.push(pid);
        child.emit("close", null);
      },
      spawn: () => child,
    },
  );
  child.emit("error", new Error("write EPIPE"));
  await owned.killAndWait();
  expect(signals).toContain(-515151);
  const result = await owned.result;
  expect(result.error?.message).toBe("write EPIPE");
});

it("reports a failed signal without treating the child as closed", async () => {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: 616161 });
  child.kill = () => {
    throw new Error("kill failed");
  };
  const owned = runOwnedProcess(
    "sleep",
    [],
    {},
    {
      closeWaitMs: 30,
      signalProcess: () => {
        throw new Error("signal failed");
      },
      spawn: () => child,
    },
  );
  child.emit("error", new Error("still running"));
  await expect(owned.killAndWait()).rejects.toThrow(/signal failed/);
});

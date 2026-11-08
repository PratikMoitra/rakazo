// Phase-1 test helper. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Acceptance children receive an allowlisted environment derived from a cluster this runner created.
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureHandle } from "@rakazo/db";
import { fixtureChildEnv } from "./phase1-fixture-env.js";

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** Ignores any database URL already in the parent environment. The handle comes from the allocation. */
export function ownedAcceptanceEnv(admin: URL, handle: FixtureHandle): NodeJS.ProcessEnv {
  const runtime = new URL(admin.toString());
  runtime.username = "rakazo_phase1_runtime";
  runtime.password = "phase1-runtime-password";
  const worker = new URL(admin.toString());
  worker.username = "rakazo_credential_worker";
  worker.password = "phase1-worker-password";
  return {
    ...fixtureChildEnv({
      databaseUrl: runtime.toString(),
      migrationUrl: admin.toString(),
      workerUrl: worker.toString(),
      realtimeUrl: runtime.toString(),
      handlePath: handle.path,
      token: handle.token,
      allocationId: handle.id,
    }),
    VERIFY_DATABASE: "1",
    PHASE1_FIXTURE_CLUSTER: "1",
  };
}

export async function allocateAll<T extends { stop: () => Promise<void> }>(
  starts: Array<() => Promise<T>>,
): Promise<T[]> {
  const allocated: T[] = [];
  const results = await Promise.allSettled(
    starts.map(async (start) => {
      const value = await start();
      allocated.push(value);
      return value;
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (!failed) return allocated;
  const errors: unknown[] = [failed.reason];
  for (const value of allocated) {
    try {
      await value.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AggregateError(errors, "fixture allocation failed");
}

export async function stopAll(stops: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const stop of stops) {
    try {
      await stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "fixture stop failed");
}

export interface OwnedProcessResult {
  code: number | null;
  output: string;
  error?: Error;
}

/** Starts a child in its own process group. killAndWait runs before cluster teardown. */
export function runOwnedProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: {
    cwd?: string;
    timeoutMs?: number;
    spawn?: (
      command: string,
      args: readonly string[],
      options: { cwd?: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["ignore", "pipe", "pipe"] },
    ) => ChildProcess;
    signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): { result: Promise<OwnedProcessResult>; killAndWait: () => Promise<void> } {
  let child: ChildProcess | undefined;
  let settled = false;
  let resolveResult: (value: OwnedProcessResult) => void = () => undefined;
  const result = new Promise<OwnedProcessResult>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (value: OwnedProcessResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveResult(value);
  };
  const signalOwned = () => {
    if (!child?.pid) return;
    const signal = options.signalProcess ?? defaultSignal;
    try {
      signal(-child.pid, "SIGKILL");
    } catch {
      try {
        signal(child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  let output = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signalOwned();
  }, options.timeoutMs ?? 120_000);
  try {
    child = (options.spawn ?? nodeSpawn)(command, args, {
      cwd: options.cwd ?? repoRoot(),
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    finish({ code: null, output: "", error: error as Error });
    return { result, killAndWait: async () => undefined };
  }
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.on("error", (error) => finish({ code: null, output, error }));
  child.on("close", (code) =>
    finish({
      code,
      output,
      ...(timedOut ? { error: new Error("owned process timed out") } : {}),
    }),
  );
  return {
    result,
    killAndWait: async () => {
      if (!settled) signalOwned();
      await result;
    },
  };
}

function defaultSignal(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

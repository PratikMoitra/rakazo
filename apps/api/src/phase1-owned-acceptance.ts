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
  /** False when the process was not observed to exit. Do not delete its cluster. */
  closed: boolean;
}

/** Starts a child in its own process group. killAndWait runs before cluster teardown. */
export function runOwnedProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: {
    cwd?: string;
    timeoutMs?: number;
    closeWaitMs?: number;
    spawn?: (
      command: string,
      args: readonly string[],
      options: {
        cwd?: string;
        env: NodeJS.ProcessEnv;
        detached: boolean;
        stdio: ["ignore", "pipe", "pipe"];
      },
    ) => ChildProcess;
    signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): { result: Promise<OwnedProcessResult>; killAndWait: () => Promise<void> } {
  let child: ChildProcess | undefined;
  let closed = false;
  let reported = false;
  let pendingError: Error | undefined;
  let resolveResult: (value: OwnedProcessResult) => void = () => undefined;
  let resolveClosed: () => void = () => undefined;
  const result = new Promise<OwnedProcessResult>((resolve) => {
    resolveResult = resolve;
  });
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const report = (value: OwnedProcessResult) => {
    if (reported) return;
    reported = true;
    resolveResult(value);
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const markClosed = (code: number | null) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    resolveClosed();
    report({
      code,
      output,
      closed: true,
      ...(pendingError ? { error: pendingError } : {}),
      ...(timedOut ? { error: new Error("owned process timed out") } : {}),
    });
  };
  const reportUnclosed = (error: Error) => {
    clearTimeout(timer);
    clearTimeout(deadline);
    report({ code: null, output, error, closed: false });
  };
  const signalFailures: unknown[] = [];
  const signalOwned = () => {
    if (!child?.pid) return;
    const signal = options.signalProcess ?? defaultSignal;
    try {
      signal(-child.pid, "SIGKILL");
    } catch (error) {
      signalFailures.push(error);
      try {
        signal(child.pid, "SIGKILL");
      } catch (fallback) {
        signalFailures.push(fallback);
        try {
          child.kill("SIGKILL");
        } catch (killError) {
          signalFailures.push(killError);
        }
      }
    }
  };
  let output = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    pendingError = new Error("owned process timed out");
    signalOwned();
    deadline = setTimeout(() => {
      if (closed || reported) return;
      reportUnclosed(
        new Error(
          signalFailures.length ? "owned process signal failed" : "owned process did not exit",
        ),
      );
    }, options.closeWaitMs ?? 1_000);
  }, options.timeoutMs ?? 120_000);
  const killAndWait = async () => {
    if (!child?.pid) {
      await result;
      return;
    }
    if (!closed) signalOwned();
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      closedPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        closeTimer = setTimeout(() => resolve(false), options.closeWaitMs ?? 1_000);
      }),
    ]);
    clearTimeout(closeTimer);
    if (!exited) {
      const error = new Error(
        signalFailures.length ? "owned process signal failed" : "owned process did not exit",
      );
      reportUnclosed(error);
      throw error;
    }
    await result;
  };
  try {
    child = (options.spawn ?? nodeSpawn)(command, args, {
      cwd: options.cwd ?? repoRoot(),
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    clearTimeout(timer);
    report({ code: null, output: "", error: error as Error, closed: true });
    resolveClosed();
    closed = true;
    return { result, killAndWait };
  }
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.on("error", (error) => {
    pendingError = error;
    if (!child?.pid) markClosed(null);
  });
  child.on("close", (code) => markClosed(code));
  return { result, killAndWait };
}

function defaultSignal(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

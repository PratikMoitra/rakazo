// Phase-1 test helper. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Acceptance children receive an allowlisted environment derived from a cluster this runner created.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureChildEnv } from "./phase1-fixture-env.js";

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** Ignores any database URL already in the parent environment. */
export function ownedAcceptanceEnv(admin: URL, clusterId: string = randomUUID()): NodeJS.ProcessEnv {
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
    }),
    VERIFY_DATABASE: "1",
    PHASE1_FIXTURE_CLUSTER: "1",
    RAKAZO_OWNED_FIXTURE_ID: clusterId,
  };
}

export function runOwnedProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = repoRoot(),
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

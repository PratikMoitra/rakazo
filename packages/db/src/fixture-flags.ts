// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.

const PHASE1_FIXTURE_FLAGS = [
  "PHASE1_DUMMY_SECRET_STORE",
  "PHASE1_DUMMY_CRASH_AFTER_DELETE",
] as const;

/**
 * Rejects phase-1 fixture flags before a service opens a database or a secret
 * store. NODE_ENV is not consulted: it is ordinary configuration.
 */
export function rejectPhase1FixtureFlags(env: NodeJS.ProcessEnv): void {
  for (const name of PHASE1_FIXTURE_FLAGS) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") {
      throw new Error("phase1 fixture flags are not accepted by this worker");
    }
  }
}

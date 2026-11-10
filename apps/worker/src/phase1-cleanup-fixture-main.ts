// Phase-1 test entrypoint. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// The production build lists src/index.ts and src/health-check.ts only.
import { runAsSystem } from "@rakazo/db";
import { startWorker } from "./index.js";
import { phase1FixtureSecretStore } from "./phase1-fixture-secret-store.js";

const fileFlag = process.argv.indexOf("--secret-file");
const secretFile = fileFlag >= 0 ? process.argv[fileFlag + 1] : undefined;
if (!secretFile) throw new Error("fixture secret file is required");

const secretStore = phase1FixtureSecretStore(secretFile, {
  crashAfterDelete: process.argv.includes("--crash-after-delete"),
});

runAsSystem("worker fixture", () => startWorker({ secretStore })).catch(async (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "worker startup failed"}\n`);
  process.exit(1);
});

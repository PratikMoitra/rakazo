// `pnpm db:migrate`: schema migrations, the job queue schema, then the runtime
// login. Everything here runs as the migration (owner) role; the API and worker
// then connect with DATABASE_URL and only get the runtime grants.
import { execFileSync } from "node:child_process";
import { migrateJobQueue, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  assertFixtureDatabaseEnv,
  credentialWorkerTarget,
  databaseUrls,
  deployMigrations,
  installQueueBoundary,
  preflightCredentialWorker,
  preflightQueueBoundary,
  provisionCredentialWorker,
  provisionRuntimeRole,
  RUNTIME_ROLE,
  SINGLE_DATABASE_URL_WARNING,
} from "@rakazo/db";

loadRootEnv();
await unwrapEnvFromKeyManager();
assertFixtureDatabaseEnv(process.env);
const urls = databaseUrls(process.env);
const credentialWorker = credentialWorkerTarget(urls.url, process.env.DATABASE_WORKER_URL);
if (credentialWorker.mode === "on") {
  await preflightCredentialWorker(urls.migrationUrl, credentialWorker.url);
}
await preflightQueueBoundary(urls.migrationUrl);
await deployMigrations({
  migrationUrl: urls.migrationUrl,
  previousMigrations: process.env.RAKAZO_DEPLOYED_MIGRATIONS?.split(","),
  dbPackageDir: execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "pwd"], {
    encoding: "utf8",
  }).trim(),
});
await migrateJobQueue(urls.migrationUrl);
await installQueueBoundary(urls.migrationUrl);
if (credentialWorker.mode === "on") {
  await provisionCredentialWorker(urls.migrationUrl, credentialWorker.url);
}

if (!urls.separate) {
  process.stderr.write(`WARNING: ${SINGLE_DATABASE_URL_WARNING}\n`);
} else {
  const { warning } = await provisionRuntimeRole(urls.migrationUrl, urls.url);
  if (warning) process.stderr.write(`WARNING: ${warning}\n`);
  else process.stdout.write(`Runtime login is ready (member of ${RUNTIME_ROLE}).\n`);
}

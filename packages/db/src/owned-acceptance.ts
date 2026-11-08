// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Acceptance suites run only from a live allocation handle. A flag or id is not authorization.

import { currentFixtureAllocation, OWNERSHIP_REFUSAL } from "./fixture-allocation.js";

const REFUSAL = "acceptance suite refuses an external database url";

export interface OwnedChannels {
  databaseUrl: string;
  migrationUrl: string;
  workerUrl: string;
  realtimeUrl: string;
  clusterId: string;
  host: string;
  port: string;
}

function endpoint(value: string): { host: string; port: string; database: string } {
  const url = new URL(value);
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  return { host, port: url.port, database: decodeURIComponent(url.pathname.replace(/^\//, "")) };
}

/** Undefined only when no acceptance input is present. A supplied URL without a handle throws. */
export function acceptanceChannels(
  env: NodeJS.ProcessEnv = process.env,
): OwnedChannels | undefined {
  const supplied = Boolean(
    env.DATABASE_URL ||
      env.DATABASE_MIGRATION_URL ||
      env.DATABASE_WORKER_URL ||
      env.REALTIME_DATABASE_URL ||
      env.RAKAZO_OWNED_FIXTURE_ID ||
      env.RAKAZO_DISPOSABLE_FIXTURE,
  );
  if (!env.RAKAZO_FIXTURE_HANDLE || !env.RAKAZO_FIXTURE_TOKEN) {
    if (supplied) throw new Error(REFUSAL);
    return undefined;
  }
  const allocation = currentFixtureAllocation(env);
  const databaseUrl = env.DATABASE_URL;
  const migrationUrl = env.DATABASE_MIGRATION_URL;
  const workerUrl = env.DATABASE_WORKER_URL;
  const realtimeUrl = env.REALTIME_DATABASE_URL;
  if (!databaseUrl || !migrationUrl || !workerUrl || !realtimeUrl) throw new Error(REFUSAL);
  const targets = [databaseUrl, migrationUrl, workerUrl, realtimeUrl].map(endpoint);
  const first = targets[0]!;
  if (
    targets.some(
      (item) =>
        item.host !== first.host ||
        item.port !== first.port ||
        item.database !== first.database ||
        item.host !== allocation.host ||
        Number(item.port) !== allocation.port ||
        !allocation.databases.includes(item.database),
    )
  ) {
    throw new Error("acceptance suite refuses a mixed database target");
  }
  if (env.RAKAZO_OWNED_FIXTURE_ID !== allocation.id) throw new Error(OWNERSHIP_REFUSAL);
  return {
    databaseUrl,
    migrationUrl,
    workerUrl,
    realtimeUrl,
    clusterId: allocation.id,
    host: allocation.host,
    port: String(allocation.port),
  };
}

// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Acceptance suites run only when the owned runner set every database channel. They do not fall back.

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

function endpoint(value: string): { host: string; port: string } {
  const url = new URL(value);
  return { host: url.hostname, port: url.port };
}

/** Undefined when this process was not started by the owned runner. */
export function acceptanceChannels(
  env: NodeJS.ProcessEnv = process.env,
): OwnedChannels | undefined {
  if (!env.RAKAZO_OWNED_FIXTURE_ID) return undefined;
  const databaseUrl = env.DATABASE_URL;
  const migrationUrl = env.DATABASE_MIGRATION_URL;
  const workerUrl = env.DATABASE_WORKER_URL;
  const realtimeUrl = env.REALTIME_DATABASE_URL;
  if (!databaseUrl || !migrationUrl || !workerUrl || !realtimeUrl) throw new Error(REFUSAL);
  const targets = [databaseUrl, migrationUrl, workerUrl, realtimeUrl].map(endpoint);
  const first = targets[0]!;
  if (targets.some((item) => item.host !== first.host || item.port !== first.port)) {
    throw new Error("acceptance suite refuses a mixed database target");
  }
  if (first.host !== "127.0.0.1" && first.host !== "::1") throw new Error(REFUSAL);
  return {
    databaseUrl,
    migrationUrl,
    workerUrl,
    realtimeUrl,
    clusterId: env.RAKAZO_OWNED_FIXTURE_ID,
    host: first.host,
    port: first.port,
  };
}

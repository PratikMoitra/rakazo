// Phase-1 test helper. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Child processes receive only these names. Ambient provider and database settings are not copied.

const FIXTURE_ENV_KEYS = [
  "PATH",
  "NODE_ENV",
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "DATABASE_WORKER_URL",
  "REALTIME_DATABASE_URL",
  "SANDBOX_PROVIDER",
  "AGENT_RUNTIME",
  "RAKAZO_ALLOW_DEV_SECRETS",
  "DB_POOL_MAX",
  "ENCRYPTION_KEY",
] as const;

export function fixtureChildEnv(input: {
  databaseUrl: string;
  migrationUrl: string;
  workerUrl: string;
  realtimeUrl: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    DATABASE_URL: input.databaseUrl,
    DATABASE_MIGRATION_URL: input.migrationUrl,
    DATABASE_WORKER_URL: input.workerUrl,
    REALTIME_DATABASE_URL: input.realtimeUrl,
    SANDBOX_PROVIDER: "none",
    AGENT_RUNTIME: "scripted",
    RAKAZO_ALLOW_DEV_SECRETS: "1",
    DB_POOL_MAX: "8",
    ENCRYPTION_KEY: "phase1-fixture-encryption-key-32ch",
  };
}

export function fixtureEnvKeys(): readonly string[] {
  return FIXTURE_ENV_KEYS;
}

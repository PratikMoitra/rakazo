// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// The only pg Client and Pool constructors for this branch live here. Remote TLS is not implemented.
import { Client, Pool } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

/** Query keys that cannot change the host, port, database, login, password, socket, or TLS. */
const BENIGN_PG_QUERY_KEYS = new Set(["application_name", "connect_timeout"]);

export const ENDPOINT_REFUSAL = "DATABASE_WORKER_URL is not the trusted migration endpoint";
export const TLS_REFUSAL = "DATABASE_WORKER_URL TLS mode is not explicitly supported";
export const OPTIONS_REFUSAL = "DATABASE_WORKER_URL startup options are not explicitly supported";
export const PLAINTEXT_REFUSAL =
  "plaintext database transport requires an explicit disposable fixture on literal loopback";
const LITERAL_LOOPBACK = new Set(["127.0.0.1", "::1"]);
const FIXTURE_POOL = Symbol.for("rakazo.disposableFixturePool");

/**
 * Fields taken from the installed pg connection-string parser. Clients are
 * constructed from these fields and do not receive the original string.
 */
export interface ExplicitPgConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  application_name?: string;
}

export interface FixtureConnectionPlan {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  application_name?: string;
}

export function explicitPgConfig(value: string): ExplicitPgConfig {
  assertBenignPgQuery(value);
  let parsed: ReturnType<typeof parseConnectionString>;
  try {
    parsed = parseConnectionString(value);
  } catch {
    throw new Error(ENDPOINT_REFUSAL);
  }
  if (parsed.ssl !== undefined || !parsed.host || parsed.host.startsWith("/")) {
    throw new Error(ENDPOINT_REFUSAL);
  }
  const database = parsed.database ?? "";
  const user = parsed.user ?? "";
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!database || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(ENDPOINT_REFUSAL);
  }
  const applicationName = parsed.application_name ?? undefined;
  if (applicationName !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(applicationName)) {
    throw new Error(ENDPOINT_REFUSAL);
  }
  const host = parsed.host.toLowerCase();
  assertLiteralLoopback(value, host);
  return {
    host,
    port,
    database,
    user,
    ...(typeof parsed.password === "string" && parsed.password.length > 0
      ? { password: parsed.password }
      : {}),
    ...(applicationName ? { application_name: applicationName } : {}),
  };
}

function assertLiteralLoopback(value: string, host: string): void {
  if (process.env.RAKAZO_DISPOSABLE_FIXTURE !== "1" || !LITERAL_LOOPBACK.has(host)) {
    throw new Error(PLAINTEXT_REFUSAL);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(PLAINTEXT_REFUSAL);
  }
  const presented = url.hostname.toLowerCase();
  if (presented.includes("%") || presented.includes(",") || presented.includes("@")) {
    throw new Error(PLAINTEXT_REFUSAL);
  }
  const literal = presented.startsWith("[") ? presented.slice(1, -1) : presented;
  if (literal !== host) throw new Error(PLAINTEXT_REFUSAL);
}

function assertBenignPgQuery(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(ENDPOINT_REFUSAL);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(ENDPOINT_REFUSAL);
  }
  const seen = new Set<string>();
  for (const [rawKey] of url.searchParams.entries()) {
    const key = rawKey.toLowerCase();
    if (seen.has(key) || !BENIGN_PG_QUERY_KEYS.has(key)) throw new Error(ENDPOINT_REFUSAL);
    seen.add(key);
  }
}

export function explicitWorkerClientConfig(config: ExplicitPgConfig) {
  if (process.env.RAKAZO_DISPOSABLE_FIXTURE !== "1" || !LITERAL_LOOPBACK.has(config.host)) {
    throw new Error(PLAINTEXT_REFUSAL);
  }
  if (!config.password) throw new Error(ENDPOINT_REFUSAL);
  if (process.env.PGSSLMODE) throw new Error(TLS_REFUSAL);
  if (process.env.PGOPTIONS) throw new Error(OPTIONS_REFUSAL);
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    application_name: config.application_name,
    // Explicit false: pg otherwise reads PGSSLMODE, including no-verify.
    ssl: false as const,
  };
}

/** Validates one channel and returns fields. Does not open a client. */
export function fixtureConnectionPlan(connectionString: string): FixtureConnectionPlan {
  const fields = explicitWorkerClientConfig(explicitPgConfig(connectionString));
  return {
    host: fields.host,
    port: fields.port,
    database: fields.database,
    user: fields.user,
    password: fields.password,
    ...(fields.application_name ? { application_name: fields.application_name } : {}),
  };
}

/**
 * Validates every distinct database channel before a process constructs clients.
 * An unset worker URL is the off mode. A set worker URL is its own channel.
 */
export function assertFixtureDatabaseEnv(env: NodeJS.ProcessEnv): void {
  const database = env.DATABASE_URL?.trim();
  if (!database) throw new Error("DATABASE_URL is required");
  fixtureConnectionPlan(database);
  fixtureConnectionPlan(env.DATABASE_MIGRATION_URL?.trim() || database);
  fixtureConnectionPlan(env.REALTIME_DATABASE_URL?.trim() || database);
  if (env.DATABASE_WORKER_URL === undefined) return;
  if (env.DATABASE_WORKER_URL.trim() === "") throw new Error("DATABASE_WORKER_URL is blank");
  fixtureConnectionPlan(env.DATABASE_WORKER_URL.trim());
}

export function openExplicitClient(
  config: ExplicitPgConfig,
  connectionTimeoutMillis?: number,
): Client {
  const fields = explicitWorkerClientConfig(config);
  return new Client(
    connectionTimeoutMillis === undefined ? fields : { ...fields, connectionTimeoutMillis },
  );
}

export interface FixtureClientOptions {
  applicationName?: string;
  connectionTimeoutMillis?: number;
}

/** Opens a client from the plan. The original string is not passed to pg. */
export function openFixtureClient(
  connectionString: string,
  options: FixtureClientOptions = {},
): Client {
  const plan = fixtureConnectionPlan(connectionString);
  return new Client({
    host: plan.host,
    port: plan.port,
    database: plan.database,
    user: plan.user,
    password: plan.password,
    application_name: options.applicationName ?? plan.application_name,
    ssl: false,
    ...(options.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
  });
}

export interface FixturePoolOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  applicationName?: string;
  keepAlive?: boolean;
}

/** Opens a pool from the plan and marks it so Graphile can refuse a raw pool. */
export function openFixturePool(connectionString: string, options: FixturePoolOptions = {}): Pool {
  const plan = fixtureConnectionPlan(connectionString);
  const pool = new Pool({
    host: plan.host,
    port: plan.port,
    database: plan.database,
    user: plan.user,
    password: plan.password,
    application_name: options.applicationName ?? plan.application_name,
    ssl: false,
    max: options.max ?? 4,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 0,
    keepAlive: options.keepAlive ?? true,
  });
  Object.defineProperty(pool, FIXTURE_POOL, { value: plan });
  return pool;
}

export function assertApprovedPool(pool: Pool): void {
  if (!(FIXTURE_POOL in pool)) {
    throw new Error("database pool was not opened by the disposable fixture transport");
  }
}

/**
 * URL rebuilt from the plan for the external migration engine. User query options are not copied.
 * lockTimeoutMs is the internal lock timeout only.
 */
export function fixtureEngineUrl(connectionString: string, lockTimeoutMs?: number): string {
  const plan = fixtureConnectionPlan(connectionString);
  const url = new URL("postgres://127.0.0.1/db");
  url.username = plan.user;
  url.password = plan.password;
  url.hostname = plan.host;
  url.port = String(plan.port);
  url.pathname = `/${plan.database}`;
  if (lockTimeoutMs !== undefined) {
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 600_000) {
      throw new Error(ENDPOINT_REFUSAL);
    }
    url.searchParams.set("options", `-c lock_timeout=${lockTimeoutMs}`);
  }
  return url.toString();
}

/** Child environment for the migration engine. Ambient PG* routing is not copied. */
export function fixtureEngineEnv(
  engineUrl: string,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("PG")) continue;
    if (key === "DATABASE_URL" || key === "DATABASE_MIGRATION_URL" || key === "DATABASE_WORKER_URL")
      continue;
    if (key === "REALTIME_DATABASE_URL") continue;
    env[key] = value;
  }
  env.DATABASE_URL = engineUrl;
  env.DATABASE_MIGRATION_URL = engineUrl;
  env.RAKAZO_DISPOSABLE_FIXTURE = "1";
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// The only pg Client and Pool constructors for this branch live here. Remote TLS is not implemented.
import { createRequire } from "node:module";
import path from "node:path";
import { Client, Pool } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
import { assertAllocationMatches } from "./fixture-allocation.js";

/** Query keys that cannot change the host, port, database, login, password, socket, or TLS. */
const BENIGN_PG_QUERY_KEYS = new Set(["application_name", "connect_timeout"]);

export const ENDPOINT_REFUSAL = "DATABASE_WORKER_URL is not the trusted migration endpoint";
export const TLS_REFUSAL = "DATABASE_WORKER_URL TLS mode is not explicitly supported";
export const OPTIONS_REFUSAL = "DATABASE_WORKER_URL startup options are not explicitly supported";
export const PLAINTEXT_REFUSAL =
  "plaintext database transport requires an explicit disposable fixture on literal loopback";
const LITERAL_LOOPBACK = new Set(["127.0.0.1", "::1"]);
const poolPlans = new WeakMap<Pool, FixtureConnectionPlan>();
const require = createRequire(import.meta.url);

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
  if (
    !config.user ||
    !config.database ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  ) {
    throw new Error(ENDPOINT_REFUSAL);
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
  const plan = {
    host: fields.host,
    port: fields.port,
    database: fields.database,
    user: fields.user,
    password: fields.password,
    ...(fields.application_name ? { application_name: fields.application_name } : {}),
  };
  assertAllocationMatches(plan);
  return plan;
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
  assertAllocationMatches(fields);
  const approved = {
    host: fields.host,
    port: fields.port,
    database: fields.database,
    user: fields.user,
    password: fields.password,
    application_name: fields.application_name,
    ssl: false as const,
    ...(connectionTimeoutMillis === undefined ? {} : { connectionTimeoutMillis }),
  };
  return new Client(approved);
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
  poolPlans.set(pool, plan);
  const connect = pool.connect.bind(pool);
  pool.connect = ((...args: unknown[]) => {
    assertPoolRoute(pool, plan);
    return connect(...(args as []));
  }) as Pool["connect"];
  return pool;
}

function assertPoolRoute(pool: Pool, plan: FixtureConnectionPlan): void {
  const options = pool.options;
  if (
    !options ||
    options.host !== plan.host ||
    Number(options.port) !== plan.port ||
    options.database !== plan.database ||
    options.user !== plan.user ||
    options.ssl !== false
  ) {
    throw new Error("database pool no longer matches its approved fixture plan");
  }
}

export function assertApprovedPool(pool: Pool): void {
  const plan = poolPlans.get(pool);
  if (!plan) throw new Error("database pool was not opened by the disposable fixture transport");
  assertPoolRoute(pool, plan);
}

/**
 * URL rebuilt from the plan for the external migration engine. User query options are not copied.
 * lockTimeoutMs is the internal lock timeout only.
 */
export function fixtureEngineUrl(connectionString: string, lockTimeoutMs?: number): string {
  const plan = fixtureConnectionPlan(connectionString);
  if (
    lockTimeoutMs !== undefined &&
    (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 600_000)
  ) {
    throw new Error(ENDPOINT_REFUSAL);
  }
  const host = plan.host.includes(":") ? `[${plan.host}]` : plan.host;
  const query =
    lockTimeoutMs === undefined
      ? ""
      : `?options=${encodeURIComponent(`-c lock_timeout=${lockTimeoutMs}`)}`;
  const built = `postgres://${encodeURIComponent(plan.user)}:${encodeURIComponent(plan.password)}@${host}:${plan.port}/${encodeURIComponent(plan.database)}${query}`;
  let again: ReturnType<typeof parseConnectionString>;
  try {
    again = parseConnectionString(built);
  } catch {
    throw new Error(ENDPOINT_REFUSAL);
  }
  const port = again.port ? Number(again.port) : 5432;
  if (
    again.host !== plan.host ||
    port !== plan.port ||
    again.database !== plan.database ||
    again.user !== plan.user ||
    again.password !== plan.password
  ) {
    throw new Error(ENDPOINT_REFUSAL);
  }
  if (lockTimeoutMs !== undefined && again.options !== `-c lock_timeout=${lockTimeoutMs}`) {
    throw new Error(ENDPOINT_REFUSAL);
  }
  return built;
}

const ENGINE_ENV_ALLOW = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;
const ENGINE_EXTRA_REFUSAL = "migration engine environment refuses a protected override";

/** Minimal child environment. Caller extras cannot replace the approved URL or routing settings. */
export function fixtureEngineEnv(
  engineUrl: string,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  for (const key of Object.keys(extra)) {
    if (
      key.startsWith("PG") ||
      key.startsWith("PRISMA_") ||
      key.startsWith("DATABASE_") ||
      key === "NODE_OPTIONS" ||
      key === "NODE_PATH" ||
      key === "REALTIME_DATABASE_URL" ||
      key === "DOTENV_CONFIG_PATH" ||
      key === "PATH"
    ) {
      throw new Error(ENGINE_EXTRA_REFUSAL);
    }
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENGINE_ENV_ALLOW) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.DATABASE_URL = engineUrl;
  env.DATABASE_MIGRATION_URL = engineUrl;
  env.RAKAZO_DISPOSABLE_FIXTURE = "1";
  if (process.env.RAKAZO_FIXTURE_HANDLE)
    env.RAKAZO_FIXTURE_HANDLE = process.env.RAKAZO_FIXTURE_HANDLE;
  if (process.env.RAKAZO_FIXTURE_TOKEN) env.RAKAZO_FIXTURE_TOKEN = process.env.RAKAZO_FIXTURE_TOKEN;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Resolves the installed Prisma CLI. An ambient engine binary is not consulted. */
export function pinnedPrismaCli(): string {
  const pkg = require.resolve("prisma/package.json");
  return path.join(path.dirname(pkg), "build/index.js");
}

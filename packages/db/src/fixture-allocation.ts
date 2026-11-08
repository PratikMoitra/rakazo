// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// An allocation is a runner-created handle, not a sandbox against other code in this process.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OWNERSHIP_REFUSAL = "database target is not an owned fixture allocation";
const STALE_REFUSAL = "fixture allocation is stale";
const REUSE_REFUSAL = "fixture allocation refuses a reused endpoint";

const LIVE = new Map<string, FixtureAllocation>();

export interface FixtureAllocation {
  id: string;
  token: string;
  host: string;
  port: number;
  database: string;
  databases: string[];
  users: string[];
  dataDirectory: string;
  root: string;
  path: string;
}

export interface FixtureHandle {
  id: string;
  token: string;
  path: string;
}

function literalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

function writeAllocation(allocation: FixtureAllocation): void {
  writeFileSync(allocation.path, JSON.stringify(allocation), { mode: 0o600 });
}

/** Called by the cluster runner after its own data directory exists. A flag cannot do this. */
export function registerFixtureAllocation(input: {
  host: string;
  port: number;
  database: string;
  users: string[];
  dataDirectory: string;
  root: string;
}): FixtureHandle {
  if (
    !literalHost(input.host) ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  ) {
    throw new Error(OWNERSHIP_REFUSAL);
  }
  if (!input.database || input.users.length === 0 || !existsSync(input.dataDirectory)) {
    throw new Error(OWNERSHIP_REFUSAL);
  }
  for (const existing of LIVE.values()) {
    if (existing.host === input.host && existing.port === input.port)
      throw new Error(REUSE_REFUSAL);
  }
  const allocation: FixtureAllocation = {
    id: randomUUID(),
    token: randomBytes(32).toString("hex"),
    host: input.host,
    port: input.port,
    database: input.database,
    databases: [input.database],
    users: [...new Set(input.users)],
    dataDirectory: input.dataDirectory,
    root: input.root,
    path: path.join(input.root, "allocation.json"),
  };
  writeAllocation(allocation);
  LIVE.set(allocation.id, allocation);
  return { id: allocation.id, token: allocation.token, path: allocation.path };
}

export function allowFixtureIdentity(
  handle: FixtureHandle,
  change: { user?: string; database?: string },
): void {
  const allocation = readAuthorized(handle.path, handle.token);
  if (allocation.id !== handle.id) throw new Error(OWNERSHIP_REFUSAL);
  if (change.user && !allocation.users.includes(change.user)) allocation.users.push(change.user);
  if (change.database && !allocation.databases.includes(change.database)) {
    allocation.databases.push(change.database);
  }
  writeAllocation(allocation);
  LIVE.set(allocation.id, allocation);
}

export function revokeFixtureAllocation(handle: FixtureHandle): void {
  const current = LIVE.get(handle.id);
  if (current?.token === handle.token) LIVE.delete(handle.id);
  if (existsSync(handle.path)) rmSync(handle.path, { force: true });
}

export function publishFixtureHandle(handle: FixtureHandle): () => void {
  const previous = {
    RAKAZO_FIXTURE_HANDLE: process.env.RAKAZO_FIXTURE_HANDLE,
    RAKAZO_FIXTURE_TOKEN: process.env.RAKAZO_FIXTURE_TOKEN,
    RAKAZO_OWNED_FIXTURE_ID: process.env.RAKAZO_OWNED_FIXTURE_ID,
    RAKAZO_DISPOSABLE_FIXTURE: process.env.RAKAZO_DISPOSABLE_FIXTURE,
  };
  process.env.RAKAZO_FIXTURE_HANDLE = handle.path;
  process.env.RAKAZO_FIXTURE_TOKEN = handle.token;
  process.env.RAKAZO_OWNED_FIXTURE_ID = handle.id;
  process.env.RAKAZO_DISPOSABLE_FIXTURE = "1";
  return () => restoreEnv(previous);
}

export function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function currentFixtureAllocation(env: NodeJS.ProcessEnv = process.env): FixtureAllocation {
  const handlePath = env.RAKAZO_FIXTURE_HANDLE;
  const token = env.RAKAZO_FIXTURE_TOKEN;
  if (!handlePath || !token) throw new Error(OWNERSHIP_REFUSAL);
  return readAuthorized(handlePath, token, env.RAKAZO_OWNED_FIXTURE_ID);
}

function readAuthorized(handlePath: string, token: string, expectedId?: string): FixtureAllocation {
  let parsed: FixtureAllocation;
  try {
    parsed = JSON.parse(readFileSync(handlePath, "utf8")) as FixtureAllocation;
  } catch {
    throw new Error(OWNERSHIP_REFUSAL);
  }
  if (!parsed || parsed.token !== token || !parsed.id || !parsed.dataDirectory) {
    throw new Error(OWNERSHIP_REFUSAL);
  }
  if (expectedId && expectedId !== parsed.id) throw new Error(OWNERSHIP_REFUSAL);
  const memory = LIVE.get(parsed.id);
  if (memory && memory.token !== parsed.token) throw new Error(OWNERSHIP_REFUSAL);
  if (!existsSync(parsed.dataDirectory)) throw new Error(STALE_REFUSAL);
  if (!literalHost(parsed.host)) throw new Error(OWNERSHIP_REFUSAL);
  return parsed;
}

export function assertAllocationMatches(
  plan: { host: string; port: number; database: string; user: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allocation = currentFixtureAllocation(env);
  if (
    allocation.host !== plan.host ||
    allocation.port !== plan.port ||
    !allocation.databases.includes(plan.database) ||
    !allocation.users.includes(plan.user)
  ) {
    throw new Error(OWNERSHIP_REFUSAL);
  }
}

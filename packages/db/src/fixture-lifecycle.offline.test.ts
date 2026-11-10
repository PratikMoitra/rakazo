// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Uses the real pg driver with socket connect denied. No database port is contacted.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterEach, expect, it } from "vitest";
import {
  beginFixtureClose,
  publishFixtureHandle,
  registerFixtureAllocation,
  restoreEnv,
  revokeFixtureAllocation,
} from "./fixture-allocation.js";
import { openFixtureClient, openFixturePool } from "./fixture-transport.js";

const sockets = { count: 0 };
const original = Socket.prototype.connect;

function denySockets() {
  sockets.count = 0;
  Socket.prototype.connect = function connect() {
    sockets.count += 1;
    throw new Error("socket denied");
  } as Socket["connect"];
}

afterEach(() => {
  Socket.prototype.connect = original;
});

function allocation() {
  const root = mkdtempSync(path.join(tmpdir(), "phase1-life-"));
  const data = path.join(root, "data");
  mkdirSync(data);
  const handle = registerFixtureAllocation({
    host: "127.0.0.1",
    port: 9,
    database: "db",
    users: ["fixture"],
    dataDirectory: data,
    root,
  });
  const previous = {
    RAKAZO_DISPOSABLE_FIXTURE: process.env.RAKAZO_DISPOSABLE_FIXTURE,
    RAKAZO_FIXTURE_HANDLE: process.env.RAKAZO_FIXTURE_HANDLE,
    RAKAZO_FIXTURE_TOKEN: process.env.RAKAZO_FIXTURE_TOKEN,
    RAKAZO_OWNED_FIXTURE_ID: process.env.RAKAZO_OWNED_FIXTURE_ID,
  };
  const release = publishFixtureHandle(handle);
  return { root, data, handle, release, previous };
}

const url = "postgres://fixture:secret@127.0.0.1:9/db";

it("does not connect a client or pool after its allocation is revoked", async () => {
  denySockets();
  const owned = allocation();
  const pool = openFixturePool(url, { max: 1 });
  try {
    const client = openFixtureClient(url);
    revokeFixtureAllocation(owned.handle);
    await expect(async () => {
      await client.connect();
    }).rejects.toThrow(/owned fixture/);
    await expect(async () => {
      await pool.connect();
    }).rejects.toThrow(/owned fixture/);
    expect(sockets.count).toBe(0);
  } finally {
    owned.release();
    restoreEnv(owned.previous);
    rmSync(owned.root, { recursive: true, force: true });
    await pool.end();
  }
});

it("does not let a new allocation at the same endpoint refresh an old client", async () => {
  denySockets();
  const owned = allocation();
  const client = openFixtureClient(url);
  try {
    beginFixtureClose(owned.handle);
    const replacement = registerFixtureAllocation({
      host: "127.0.0.1",
      port: 9,
      database: "db",
      users: ["fixture"],
      dataDirectory: owned.data,
      root: owned.root,
    });
    publishFixtureHandle(replacement);
    await expect(async () => {
      await client.connect();
    }).rejects.toThrow(/owned fixture/);
    expect(sockets.count).toBe(0);
    revokeFixtureAllocation(replacement);
  } finally {
    owned.release();
    restoreEnv(owned.previous);
    rmSync(owned.root, { recursive: true, force: true });
  }
});

it("rejects a connectionString override and still reaches connect for an unchanged pool", async () => {
  denySockets();
  const owned = allocation();
  const pool = openFixturePool(url, { max: 1 });
  pool.options.connectionString = "postgres://fixture:secret@203.0.113.10:9/db";
  await expect(async () => {
    await pool.connect();
  }).rejects.toThrow(/approved fixture plan/);
  expect(sockets.count).toBe(0);
  delete pool.options.connectionString;
  await expect(async () => {
    await pool.connect();
  }).rejects.toThrow(/socket denied/);
  expect(sockets.count).toBe(1);
  beginFixtureClose(owned.handle);
  sockets.count = 0;
  await expect(async () => {
    await pool.connect();
  }).rejects.toThrow(/owned fixture|stale/);
  expect(sockets.count).toBe(0);
  owned.release();
  revokeFixtureAllocation(owned.handle);
  restoreEnv(owned.previous);
  rmSync(owned.root, { recursive: true, force: true });
});

it("does not connect a queued checkout after revocation, replacement, or route mutation", async () => {
  denySockets();
  const original = Client.prototype.connect;
  let simulated = false;
  Client.prototype.connect = function connect(this: Client, callback?: (error?: Error) => void) {
    if (!simulated) {
      simulated = true;
      (this as Client & { _queryable?: boolean })._queryable = true;
      if (typeof callback === "function") {
        queueMicrotask(() => callback());
        return;
      }
      return Promise.resolve();
    }
    return original.call(this, callback as never);
  } as Client["connect"];
  const owned = allocation();
  const pool = openFixturePool(url, {
    max: 1,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 0,
  });
  try {
    const first = await pool.connect();
    const queued = pool.connect();
    beginFixtureClose(owned.handle);
    (first as Client & { release: (error?: Error) => void }).release(new Error("replaced"));
    await expect(queued).rejects.toThrow(/owned fixture|stale|approved fixture plan/);
    expect(sockets.count).toBe(0);

    const again = allocation();
    const pool2 = openFixturePool(url, { max: 1, idleTimeoutMillis: 0 });
    simulated = false;
    const held = await pool2.connect();
    const waiting = pool2.connect();
    pool2.options.connectionString = "postgres://fixture:secret@203.0.113.10:9/db";
    (held as Client & { release: (error?: Error) => void }).release(new Error("replaced"));
    await expect(waiting).rejects.toThrow(/approved fixture plan/);
    expect(sockets.count).toBe(0);
    simulated = false;
    const poolSsl = openFixturePool(url, { max: 1, idleTimeoutMillis: 0 });
    const heldSsl = await poolSsl.connect();
    const waitingSsl = poolSsl.connect();
    poolSsl.options.ssl = { rejectUnauthorized: false };
    (heldSsl as Client & { release: (error?: Error) => void }).release(new Error("replaced"));
    await expect(waitingSsl).rejects.toThrow(/approved fixture plan/);
    expect(sockets.count).toBe(0);

    const pool3 = openFixturePool(url, { max: 1, idleTimeoutMillis: 0 });
    simulated = false;
    const idle = await pool3.connect();
    const reused = pool3.connect();
    beginFixtureClose(again.handle);
    (idle as Client & { release: () => void }).release();
    await expect(reused).rejects.toThrow(/owned fixture|stale/);
    expect(sockets.count).toBe(0);
    again.release();
    revokeFixtureAllocation(again.handle);
    restoreEnv(again.previous);
    rmSync(again.root, { recursive: true, force: true });
  } finally {
    Client.prototype.connect = original;
    owned.release();
    restoreEnv(owned.previous);
    rmSync(owned.root, { recursive: true, force: true });
  }
});

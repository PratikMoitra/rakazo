// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Offline only. Socket and pg constructors are denied. No database port is contacted.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OWNERSHIP_REFUSAL,
  PLAINTEXT_REFUSAL,
  publishFixtureHandle,
  registerFixtureAllocation,
  restoreEnv,
  revokeFixtureAllocation,
} from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { PostgresRealtimeFanout } from "./realtime.js";
import { migrateJobQueue } from "./wakeup.js";

const counts = vi.hoisted(() => ({ clients: 0, pools: 0, sockets: 0 }));

vi.mock("pg", () => ({
  Client: class {
    constructor() {
      counts.clients += 1;
    }
    connect() {
      return Promise.reject(new Error("client connect denied"));
    }
    end() {
      return Promise.resolve();
    }
    query() {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    on() {
      return this;
    }
  },
  Pool: class {
    constructor() {
      counts.pools += 1;
    }
    on() {
      return this;
    }
    end() {
      return Promise.resolve();
    }
  },
}));

const loopback = "postgres://fixture:secret@127.0.0.1:9/db";

it("rejects realtime and queue migration before construction when the target is not owned", async () => {
  const original = Socket.prototype.connect;
  Socket.prototype.connect = function connect() {
    counts.sockets += 1;
    throw new Error("socket denied");
  } as Socket["connect"];
  const previous = {
    RAKAZO_DISPOSABLE_FIXTURE: process.env.RAKAZO_DISPOSABLE_FIXTURE,
    DATABASE_URL: process.env.DATABASE_URL,
    PGHOST: process.env.PGHOST,
    PGSSLMODE: process.env.PGSSLMODE,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
  };
  process.env.RAKAZO_DISPOSABLE_FIXTURE = "1";
  process.env.DATABASE_URL = "postgres://ambient:ambient@203.0.113.10/preserved";
  process.env.PGHOST = "203.0.113.10";
  process.env.NODE_OPTIONS = "--require ./not-a-loader.js";
  let opened = 0;
  try {
    expect(
      () =>
        new PostgresRealtimeFanout({
          connectionString: loopback,
          publisher: { query: async () => undefined },
          clientFactory: () => {
            opened += 1;
            throw new Error("constructed");
          },
        }),
    ).toThrow(OWNERSHIP_REFUSAL);
    await expect(migrateJobQueue(loopback)).rejects.toThrow(OWNERSHIP_REFUSAL);
    await expect(migrateJobQueue("postgres://fixture:secret@evil.example/db")).rejects.toThrow(
      PLAINTEXT_REFUSAL,
    );
    const root = mkdtempSync(path.join(tmpdir(), "phase1-rt-"));
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
    const release = publishFixtureHandle(handle);
    const fanout = new PostgresRealtimeFanout({
      connectionString: loopback,
      publisher: { query: async () => undefined },
      clientFactory: () => {
        opened += 1;
        throw new Error("constructed");
      },
    });
    rmSync(data, { recursive: true, force: true });
    await fanout.subscribe("topic", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fanout.close();
    release();
    revokeFixtureAllocation(handle);
    rmSync(root, { recursive: true, force: true });
    expect(opened).toBe(0);
    expect(counts.clients).toBe(0);
    expect(counts.pools).toBe(0);
    expect(counts.sockets).toBe(0);
  } finally {
    restoreEnv(previous);
    Socket.prototype.connect = original;
  }
});

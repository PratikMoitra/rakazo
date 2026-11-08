// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { expect, it } from "vitest";
import { ownedAcceptanceEnv } from "./phase1-owned-acceptance.js";

it("derives acceptance channels from the owned cluster and ignores an ambient database url", () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://ambient:ambient@example/db";
  process.env.DATABASE_MIGRATION_URL = "postgres://ambient:ambient@example/db";
  process.env.PGSSLMODE = "no-verify";
  try {
    const admin = new URL("postgres://fixture_admin:secret@127.0.0.1:54321/postgres");
    const env = ownedAcceptanceEnv(admin, "suite-a");
    expect(env.DATABASE_URL).not.toContain("example");
    expect(env.DATABASE_MIGRATION_URL).not.toContain("example");
    expect(env.DATABASE_WORKER_URL).not.toContain("example");
    expect(env.REALTIME_DATABASE_URL).not.toContain("example");
    expect(new URL(env.DATABASE_URL!).port).toBe("54321");
    expect(new URL(env.DATABASE_MIGRATION_URL!).port).toBe("54321");
    expect(new URL(env.DATABASE_WORKER_URL!).port).toBe("54321");
    expect(new URL(env.REALTIME_DATABASE_URL!).port).toBe("54321");
    expect(new URL(env.DATABASE_URL!).hostname).toBe("127.0.0.1");
    expect(new URL(env.DATABASE_URL!).username).toBe("rakazo_phase1_runtime");
    expect(new URL(env.DATABASE_MIGRATION_URL!).username).toBe("fixture_admin");
    expect(env.RAKAZO_OWNED_FIXTURE_ID).toBe("suite-a");
    expect(env.RAKAZO_DISPOSABLE_FIXTURE).toBe("1");
    expect(env.PGSSLMODE).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(
      [
        "AGENT_RUNTIME",
        "DATABASE_MIGRATION_URL",
        "DATABASE_URL",
        "DATABASE_WORKER_URL",
        "DB_POOL_MAX",
        "ENCRYPTION_KEY",
        "NODE_ENV",
        "PATH",
        "PHASE1_FIXTURE_CLUSTER",
        "RAKAZO_ALLOW_DEV_SECRETS",
        "RAKAZO_DISPOSABLE_FIXTURE",
        "RAKAZO_OWNED_FIXTURE_ID",
        "REALTIME_DATABASE_URL",
        "SANDBOX_PROVIDER",
        "VERIFY_DATABASE",
      ].sort(),
    );
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    delete process.env.DATABASE_MIGRATION_URL;
    delete process.env.PGSSLMODE;
  }
});

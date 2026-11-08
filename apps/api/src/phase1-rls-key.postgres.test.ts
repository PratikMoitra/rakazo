// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Reproduces whether a second runtime password replaces the one database-wide bypass key.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { PrismaClient } from "@rakazo/db";
import { createDb, describeRowSecurity, provisionRuntimeRole, runAsSystem } from "@rakazo/db";
import { expect, it } from "vitest";
import { startFixtureCluster } from "./phase1-fixture-cluster.js";
import { fixtureChildEnv } from "./phase1-fixture-env.js";

it.skipIf(!existsSync("/usr/lib/postgresql/16/bin/initdb"))(
  "shows a second runtime password replaces the database bypass key",
  async () => {
    const cluster = await startFixtureCluster();
    const previous = process.env.RAKAZO_DISPOSABLE_FIXTURE;
    process.env.RAKAZO_DISPOSABLE_FIXTURE = "1";
    const admin = cluster.url;
    const first = new URL(admin);
    first.username = "rakazo_phase1_api";
    first.password = "phase1-api-password";
    const second = new URL(admin);
    second.username = "rakazo_phase1_runtime";
    second.password = "phase1-runtime-password";
    const worker = new URL(admin);
    worker.username = "rakazo_credential_worker";
    worker.password = "phase1-worker-password";
    let db: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(admin, first, worker);
      db = createDb(first.toString());
      const before = await identity(db.prisma);
      expect(before).toEqual({
        enforced: true,
        systemBlocked: false,
        bypass: true,
        rolsuper: false,
        rolbypassrls: false,
        member: true,
      });
      await provisionRuntimeRole(admin.toString(), second.toString());
      await db.prisma.$disconnect();
      await db.pool.end();
      db = createDb(first.toString());
      const after = await identity(db.prisma);
      expect(after.enforced).toBe(true);
      expect(after.systemBlocked).toBe(true);
      expect(after.bypass).toBe(false);
      expect(after.rolsuper).toBe(false);
      expect(after.rolbypassrls).toBe(false);
      expect(after.member).toBe(true);
      const replacement = createDb(second.toString());
      try {
        const next = await identity(replacement.prisma);
        expect(next.enforced).toBe(true);
        expect(next.systemBlocked).toBe(false);
        expect(next.bypass).toBe(true);
        expect(next.rolsuper).toBe(false);
        expect(next.rolbypassrls).toBe(false);
        expect(next.member).toBe(true);
      } finally {
        await replacement.prisma.$disconnect();
        await replacement.pool.end();
      }
    } finally {
      await db?.prisma.$disconnect();
      await db?.pool.end();
      await cluster.stop();
      if (previous === undefined) delete process.env.RAKAZO_DISPOSABLE_FIXTURE;
      else process.env.RAKAZO_DISPOSABLE_FIXTURE = previous;
    }
  },
  120_000,
);

async function identity(prisma: PrismaClient) {
  const status = await describeRowSecurity(prisma);
  const [role] = await prisma.$queryRawUnsafe<
    Array<{ rolsuper: boolean; rolbypassrls: boolean; member: boolean }>
  >(
    `SELECT rolsuper, rolbypassrls, pg_has_role(current_user, 'rakazo_app', 'MEMBER') AS member
     FROM pg_roles WHERE rolname = current_user`,
  );
  const [bypass] = await runAsSystem("phase1 bypass probe", () =>
    prisma.$queryRawUnsafe<Array<{ ok: boolean }>>("SELECT app_rls_bypass() AS ok"),
  );
  return {
    enforced: status.enforced,
    systemBlocked: status.systemBlocked === true,
    bypass: bypass?.ok === true,
    rolsuper: role?.rolsuper === true,
    rolbypassrls: role?.rolbypassrls === true,
    member: role?.member === true,
  };
}

function migrate(admin: URL, runtime: URL, worker: URL) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      "pnpm",
      ["--filter", "@rakazo/api", "db:migrate"],
      {
        cwd: "/workspace",
        env: fixtureChildEnv({
          databaseUrl: runtime.toString(),
          migrationUrl: admin.toString(),
          workerUrl: worker.toString(),
          realtimeUrl: admin.toString(),
        }),
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(`${stderr}\n${stdout}`.replace(/postgres(?:ql)?:\/\/\S+/g, "[database]")),
          );
        else resolve();
      },
    );
  });
}

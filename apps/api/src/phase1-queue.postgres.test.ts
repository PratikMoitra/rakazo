// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { execFile } from "node:child_process";
import { performCredentialCleanup } from "@rakazo/adapters";
import {
  countLegacyCredentialJobs,
  createDb,
  createPool,
  installQueueBoundary,
  preflightCredentialWorker,
} from "@rakazo/db";
import { expect, it } from "vitest";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

it.skipIf(!databaseUrl)(
  "provisions credential cleanup through the migrate CLI and a separate worker",
  async () => {
    const adminUrl = new URL(databaseUrl!);
    const workerUrl = new URL(databaseUrl!);
    workerUrl.username = "rakazo_credential_worker";
    workerUrl.password = "phase1-worker-password";
    const apiUrl = new URL(databaseUrl!);
    apiUrl.username = "rakazo_phase1_api";
    apiUrl.password = "phase1-api-password";
    await psql(
      adminUrl,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_phase1_api') THEN
          CREATE ROLE rakazo_phase1_api LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'phase1-api-password';
        END IF;
      END $$;
      GRANT CONNECT ON DATABASE ${adminUrl.pathname.slice(1)} TO rakazo_phase1_api;
      GRANT rakazo_app TO rakazo_phase1_api;`,
    );
    const admin = createPool(databaseUrl!);
    const ownerBefore = await admin.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rakazo_queue_owner'",
    );
    const reserved = new URL(databaseUrl!);
    reserved.username = "rakazo_queue_owner";
    reserved.password = "not-used";
    await expect(preflightCredentialWorker(databaseUrl!, reserved.toString())).rejects.toThrow(
      /managed credential worker/,
    );
    const ownerAfter = await admin.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rakazo_queue_owner'",
    );
    expect(ownerAfter.rows).toEqual(ownerBefore.rows);
    const wrongDatabase = new URL(workerUrl.toString());
    wrongDatabase.pathname = "/not-the-credential-database";
    await expect(preflightCredentialWorker(databaseUrl!, wrongDatabase.toString())).rejects.toThrow(
      /same database/,
    );
    await admin.query("CREATE SCHEMA IF NOT EXISTS queue_private");
    await admin.query(
      `CREATE TABLE IF NOT EXISTS queue_private.work_item (id uuid PRIMARY KEY, entity jsonb NOT NULL)`,
    );
    await admin.query(
      `INSERT INTO queue_private.work_item (id, entity)
       VALUES ('00000000-0000-4000-8000-000000000001', '{"tombstoneId":"00000000-0000-4000-8000-000000000002"}')`,
    );
    await expect(installQueueBoundary(databaseUrl!)).rejects.toThrow(/upgrade refused/);
    const kept = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM queue_private.work_item WHERE id = '00000000-0000-4000-8000-000000000001'",
    );
    expect(kept.rows[0]?.n).toBe(1);
    await admin.query(
      "DELETE FROM queue_private.work_item WHERE id = '00000000-0000-4000-8000-000000000001'",
    );
    await runMigrate(workerUrl);
    const api = createPool(apiUrl.toString());
    const worker = createPool(workerUrl.toString());
    const created = createDb(databaseUrl!);
    const secrets = new Map<string, number>();
    const deleted: string[] = [];
    const secretStore = {
      async delete(ref: string) {
        const hits = secrets.get(ref) ?? 0;
        if (hits === 0) {
          const absent = new Error("absent");
          throw Object.assign(absent, { code: "not_found" });
        }
        secrets.set(ref, hits - 1);
        deleted.push(ref);
      },
    };
    try {
      const owner = await admin.query<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }>(`
        SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin
        FROM pg_proc AS fn
        JOIN pg_namespace AS ns ON ns.oid = fn.pronamespace
        JOIN pg_roles AS r ON r.oid = fn.proowner
        WHERE ns.nspname = 'queue_api' AND fn.proname = 'capture_current_credential'
      `);
      expect(owner.rows).toEqual([
        {
          rolname: "rakazo_queue_owner",
          rolsuper: false,
          rolbypassrls: false,
          rolcanlogin: false,
        },
      ]);
      const searchPath = await admin.query<{ proconfig: string[] | null }>(`
        SELECT fn.proconfig
        FROM pg_proc AS fn
        JOIN pg_namespace AS ns ON ns.oid = fn.pronamespace
        WHERE ns.nspname = 'queue_api' AND fn.proname = 'claim_credential_retirement'
      `);
      expect(searchPath.rows[0]?.proconfig).toContain("search_path=pg_catalog");
      const claimAllowed = await admin.query<{ allowed: boolean }>(
        `SELECT has_function_privilege('rakazo_phase1_api', 'queue_api.claim_credential_retirement(uuid)', 'EXECUTE') AS allowed`,
      );
      expect(claimAllowed.rows[0]?.allowed).toBe(false);
      const queueStillOpen = await admin.query<{ allowed: boolean }>(
        `SELECT has_schema_privilege('rakazo_phase1_api', 'graphile_worker', 'USAGE') AS allowed`,
      );
      expect(queueStillOpen.rows[0]?.allowed).toBe(true);
      expect(
        await sqlState(api, "SELECT retired_ref FROM queue_private.credential_retirement"),
      ).toBe("42501");
      expect(
        await sqlState(
          api,
          "SELECT * FROM queue_api.claim_credential_retirement('00000000-0000-0000-0000-000000000000'::uuid)",
        ),
      ).toBe("42501");

      const userId = "phase1-cleanup-user";
      const spaceId = "phase1-cleanup-space";
      const botId = "phase1-cleanup-bot";
      await admin.query(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, 'Cleanup', $2, true, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [userId, "phase1-cleanup@example.test"],
      );
      await admin.query(
        `INSERT INTO organization (id, name, slug, "createdAt")
         VALUES ($1, 'Cleanup', 'phase1-cleanup', now()) ON CONFLICT (id) DO NOTHING`,
        [spaceId],
      );
      await admin.query(
        `INSERT INTO spaces (id, name, "organizationId", "createdAt")
         VALUES ($1, 'Cleanup', $1, now()) ON CONFLICT (id) DO NOTHING`,
        [spaceId],
      );
      await admin.query(
        `INSERT INTO bots (id, name, "spaceId", "userId", color, "createdAt", "updatedAt")
         VALUES ($1, 'Cleanup', $2, $3, 'ink', now(), now()) ON CONFLICT (id) DO NOTHING`,
        [botId, spaceId, userId],
      );
      await admin.query("SELECT queue_api.register_active_credential('retired-a')");
      await admin.query(
        `INSERT INTO messaging_installations
           (id, provider, "workspaceId", "workspaceName", "spaceId", "userId", "botId", ciphertext, "createdAt", "updatedAt")
         VALUES ('phase1-install', 'slack', 'W-phase1', 'W', $1, $2, $3, 'retired-a', now(), now())
         ON CONFLICT (id) DO UPDATE SET ciphertext = 'retired-a'`,
        [spaceId, userId, botId],
      );
      await admin.query(
        `DELETE FROM queue_private.credential_retirement WHERE installation_id IN ('phase1-install', 'phase1-install-2')`,
      );
      await admin.query(
        `DELETE FROM graphile_worker._private_jobs AS jobs
         USING graphile_worker._private_tasks AS tasks
         WHERE jobs.task_id = tasks.id AND tasks.identifier = 'work.dispatch' AND jobs.locked_at IS NULL`,
      );
      secrets.set("retired-a", 1);
      secrets.set("current-b", 1);
      const client = await admin.connect();
      let workItemId = "";
      try {
        await client.query("BEGIN");
        const captured = await client.query<{ id: string }>(
          "SELECT queue_api.capture_current_credential($1::text) AS id",
          ["phase1-install"],
        );
        workItemId = captured.rows[0]?.id ?? "";
        expect(workItemId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        const version = await client.query<{ version: number }>(
          "SELECT version FROM queue_private.credential_retirement WHERE id = $1::uuid",
          [workItemId],
        );
        expect(version.rows[0]?.version).toBe(1);
        await client.query("SELECT queue_api.register_active_credential('current-b')");
        await client.query(
          `UPDATE messaging_installations SET ciphertext = 'current-b' WHERE id = 'phase1-install'`,
        );
        await client.query("SELECT queue_api.enqueue_captured_credential($1::uuid)", [workItemId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const payload = await worker.query<{ only_id: boolean }>(
        `SELECT (payload::jsonb - 'workItemId') = '{}'::jsonb AS only_id
         FROM graphile_worker._private_jobs WHERE key = $1`,
        [`credential-cleanup:${workItemId}`],
      );
      expect(payload.rows).toEqual([{ only_id: true }]);
      expect(
        await sqlState(
          admin,
          "UPDATE messaging_installations SET ciphertext = 'retired-a' WHERE id = 'phase1-install'",
        ),
      ).toBe("23514");
      const stillCurrent = await admin.query<{ ok: boolean }>(
        "SELECT ciphertext = 'current-b' AS ok FROM messaging_installations WHERE id = 'phase1-install'",
      );
      expect(stillCurrent.rows[0]?.ok).toBe(true);
      const child = await runCleanupProcess(workerUrl, workItemId);
      expect(child).toBe("deleted");
      expect(secrets.get("current-b")).toBe(1);
      deleted.push("retired-a");
      await performCredentialCleanup({ pool: worker, secretStore }, workItemId);
      expect(deleted).toHaveLength(1);
      await admin.query(
        `SELECT graphile_worker.add_job(
           'work.dispatch'::text,
           json_build_object('workItemId', $1::uuid),
           NULL::text, NULL::timestamptz, 5, 'phase1-redact-probe'::text,
           NULL::integer, NULL::text[], 'replace'::text)`,
        [workItemId],
      );
      const redacted = await admin.query<{ last_error: string | null }>(
        `UPDATE graphile_worker._private_jobs
         SET last_error = 'SENTINEL-value'
         WHERE key = 'phase1-redact-probe'
         RETURNING last_error`,
      );
      expect(redacted.rows[0]?.last_error).toBe("SENTINEL-value");
      await worker.query("SELECT queue_api.redact_dispatch_errors()");
      const cleaned = await worker.query<{ last_error: string | null }>(
        "SELECT last_error FROM graphile_worker._private_jobs WHERE key = 'phase1-redact-probe'",
      );
      expect(cleaned.rows[0]?.last_error).toBe("redacted");
      await admin.query("SELECT graphile_worker.remove_job('phase1-redact-probe'::text)");
      const stored = await admin.query<{ retired_ref: string | null }>(
        "SELECT retired_ref FROM queue_private.credential_retirement WHERE id = $1::uuid",
        [workItemId],
      );
      expect(stored.rows[0]?.retired_ref).toBeNull();
      await admin.query(
        `UPDATE queue_private.credential_retirement
         SET redacted_at = clock_timestamp() - interval '8 days'
         WHERE id = $1::uuid`,
        [workItemId],
      );
      const purged = await worker.query<{ removed: number }>(
        "SELECT queue_api.purge_redacted_retirements(7) AS removed",
      );
      expect(purged.rows[0]?.removed).toBeGreaterThanOrEqual(1);

      await admin.query("SELECT queue_api.register_active_credential('same-ref')");
      await admin.query(
        `INSERT INTO messaging_installations
           (id, provider, "workspaceId", "workspaceName", "spaceId", "userId", "botId", ciphertext, "createdAt", "updatedAt")
         VALUES ('phase1-install-2', 'slack', 'W-phase1-2', 'W', $1, $2, $3, 'same-ref', now(), now())
         ON CONFLICT (id) DO UPDATE SET ciphertext = 'same-ref'`,
        [spaceId, userId, botId],
      );
      const skip = await admin.query<{ id: string }>(
        "SELECT queue_api.capture_current_credential('phase1-install-2') AS id",
      );
      const skipped = await worker.query(
        "SELECT installation_id FROM queue_api.claim_credential_retirement($1::uuid)",
        [skip.rows[0]?.id],
      );
      expect(skipped.rowCount).toBe(0);
      const skippedState = await admin.query<{ state: string; retired_ref: string | null }>(
        "SELECT state, retired_ref FROM queue_private.credential_retirement WHERE id = $1::uuid",
        [skip.rows[0]?.id],
      );
      expect(skippedState.rows[0]).toEqual({ state: "skipped_current", retired_ref: null });

      const beforeLegacy = await countLegacyCredentialJobs(admin);
      const legacy = await admin.connect();
      try {
        await legacy.query("BEGIN");
        await legacy.query(
          `SELECT graphile_worker.add_job(
             'messaging.credential-cleanup'::text,
             json_build_object('installationId', 'phase1-install', 'ref', 'legacy-ref'),
             NULL::text, NULL::timestamptz, 5, 'phase1-legacy-cleanup'::text,
             NULL::integer, NULL::text[], 'replace'::text)`,
        );
        expect(await countLegacyCredentialJobs(legacy)).toBe(beforeLegacy + 1);
        await legacy.query("ROLLBACK");
      } finally {
        legacy.release();
      }
      expect(await countLegacyCredentialJobs(admin)).toBe(beforeLegacy);
    } finally {
      await admin.end();
      await api.end();
      await worker.end();
      await created.prisma.$disconnect();
    }
  },
  120_000,
);

async function sqlState(
  pool: { query: (sql: string) => Promise<unknown> },
  sql: string,
): Promise<string> {
  try {
    await pool.query(sql);
  } catch (error) {
    return (error as { code?: string }).code ?? "";
  }
  return "";
}

function runCleanupProcess(workerUrl: URL, workItemId: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "pnpm",
      ["--filter", "@rakazo/api", "exec", "tsx", "src/phase1-cleanup-once.ts"],
      {
        cwd: "/workspace",
        env: {
          ...process.env,
          DATABASE_WORKER_URL: workerUrl.toString(),
          PHASE1_WORK_ITEM_ID: workItemId,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              (stderr || stdout || error.message).replaceAll(workerUrl.toString(), "[worker]"),
            ),
          );
        } else resolve(stdout.trim());
      },
    );
  });
}

function runMigrate(workerUrl: URL) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      "pnpm",
      ["--filter", "@rakazo/api", "db:migrate"],
      {
        cwd: "/workspace",
        env: { ...process.env, DATABASE_WORKER_URL: workerUrl.toString() },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              (stderr || stdout || error.message).replaceAll(workerUrl.toString(), "[worker]"),
            ),
          );
        } else resolve();
      },
    );
  });
}

function psql(url: URL, sql: string) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      "psql",
      [
        "-h",
        url.hostname,
        "-p",
        url.port || "5432",
        "-U",
        decodeURIComponent(url.username),
        "-d",
        url.pathname.slice(1),
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || stdout || error.message));
        else resolve();
      },
    );
  });
}

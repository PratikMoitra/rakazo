// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performCredentialCleanup } from "@rakazo/adapters";
import {
  countLegacyCredentialJobs,
  createDb,
  createPool,
  preflightCredentialWorker,
  preflightQueueBoundary,
} from "@rakazo/db";
import { expect, it } from "vitest";
import { startFixtureCluster } from "./phase1-fixture-cluster.js";

it.skipIf(!existsSync("/usr/lib/postgresql/16/bin/initdb"))(
  "provisions credential cleanup on a fixture cluster and restarts the worker with operator assistance",
  async () => {
    const refusal = await startFixtureCluster();
    let success: { url: URL; stop: () => Promise<void> } | undefined;
    const databaseUrl = refusal.url.toString();
    const adminUrl = refusal.url;
    let refusalStopped = false;
    try {
      const workerUrl = new URL(databaseUrl!);
      workerUrl.username = "rakazo_credential_worker";
      workerUrl.password = "phase1-worker-password";
      let admin = createPool(databaseUrl!);
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
      await expect(
        preflightCredentialWorker(databaseUrl, wrongDatabase.toString()),
      ).rejects.toThrow(/trusted migration endpoint/);
      await admin.query("CREATE SCHEMA IF NOT EXISTS queue_private");
      await admin.query(
        `CREATE TABLE IF NOT EXISTS queue_private.work_item (id uuid PRIMARY KEY, entity jsonb NOT NULL)`,
      );
      await admin.query(
        `INSERT INTO queue_private.work_item (id, entity)
       VALUES ('00000000-0000-4000-8000-000000000001', '{"tombstoneId":"00000000-0000-4000-8000-000000000002"}')`,
      );
      await expect(preflightQueueBoundary(databaseUrl)).rejects.toThrow(/upgrade refused/);
      const kept = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM queue_private.work_item WHERE id = '00000000-0000-4000-8000-000000000001'",
      );
      expect(kept.rows[0]?.n).toBe(1);
      const legacyDb = await createFreshDatabase(adminUrl);
      await seedLegacyQueue(legacyDb);
      await expect(
        runMigrate(
          legacyDb,
          loginUrl(legacyDb, "rakazo_credential_worker", "phase1-worker-password"),
        ),
      ).rejects.toThrow(/upgrade refused/);
      expect(await migrationCount(legacyDb)).toBe(0);
      expect(
        await scalar(
          legacyDb,
          "SELECT count(*)::int AS n FROM queue_private.credential_retirement",
        ),
      ).toBe(4);
      expect(
        await scalar(
          legacyDb,
          "SELECT count(*)::int AS n FROM messaging_installations WHERE length(ciphertext) > 0",
        ),
      ).toBe(1);
      const unrelatedDb = await createFreshDatabase(adminUrl);
      const snapshot = await admin.connect();
      try {
        await snapshot.query(
          "CREATE ROLE rakazo_credential_worker LOGIN PASSWORD 'phase1-original'",
        );
        await snapshot.query(
          `CREATE TEMP TABLE phase1_password_snapshot AS
         SELECT rolpassword FROM pg_authid WHERE rolname = 'rakazo_credential_worker'`,
        );
        await expect(
          runMigrate(
            unrelatedDb,
            loginUrl(unrelatedDb, "rakazo_credential_worker", "phase1-worker-password"),
          ),
        ).rejects.toThrow(/unrelated preexisting role/);
        const unchanged = await snapshot.query<{ unchanged: boolean }>(
          `SELECT (
           SELECT rolpassword FROM pg_authid WHERE rolname = 'rakazo_credential_worker'
         ) IS NOT DISTINCT FROM (
           SELECT rolpassword FROM phase1_password_snapshot
         ) AS unchanged`,
        );
        expect(unchanged.rows[0]?.unchanged).toBe(true);
      } finally {
        snapshot.release();
      }
      expect(await migrationCount(unrelatedDb)).toBe(0);

      await admin.end();
      await refusal.stop();
      refusalStopped = true;
      success = await startFixtureCluster();
      try {
        const fresh = success.url;
        const freshWorker = loginUrl(fresh, "rakazo_credential_worker", "phase1-worker-password");
        const freshApi = loginUrl(fresh, "rakazo_phase1_api", "phase1-api-password");
        await runMigrate(fresh, freshWorker, freshApi);
        await psql(
          fresh,
          `GRANT CONNECT ON DATABASE ${fresh.pathname.slice(1)} TO rakazo_phase1_api;
       GRANT rakazo_app TO rakazo_phase1_api;`,
        );
        admin = createPool(fresh.toString());
        const api = createPool(freshApi.toString());
        const worker = createPool(freshWorker.toString());
        const created = createDb(fresh.toString());
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
          expect(
            await sqlState(
              api,
              "ALTER TABLE messaging_installations DISABLE TRIGGER credential_object_is_attachable",
            ),
          ).toBe("42501");
          expect(await sqlState(api, "SET session_replication_role = replica")).toBe("42501");
          expect(await sqlState(api, "SET ROLE rakazo_queue_owner")).toBe("42501");
          expect(
            await sqlState(api, "UPDATE queue_private.credential_fingerprint SET state = 'active'"),
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
          await admin.query(
            "SELECT queue_api.register_active_credential('phase1-install', 'retired-a')",
          );
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
            await client.query(
              "SELECT queue_api.register_active_credential('phase1-install', 'current-b')",
            );
            await client.query(
              `UPDATE messaging_installations SET ciphertext = 'current-b' WHERE id = 'phase1-install'`,
            );
            await client.query("SELECT queue_api.enqueue_captured_credential($1::uuid)", [
              workItemId,
            ]);
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
          const held = await worker.query<{ status: string }>(
            "SELECT status FROM queue_api.claim_credential_retirement($1::uuid)",
            [workItemId],
          );
          expect(held.rows[0]?.status).toBe("ready");
          await expect(
            performCredentialCleanup({ pool: worker, secretStore }, workItemId),
          ).rejects.toThrow("credential_cleanup_retry");
          const busy = await admin.query<{ state: string }>(
            "SELECT state FROM queue_private.credential_retirement WHERE id = $1::uuid",
            [workItemId],
          );
          expect(busy.rows[0]?.state).toBe("leased");
          await admin.query(
            `UPDATE queue_private.credential_retirement
         SET leased_until = clock_timestamp() - interval '1 second'
         WHERE id = $1::uuid`,
            [workItemId],
          );
          const renewed = await worker.query<{ ok: number }>(
            "SELECT queue_api.renew_credential_lease($1::uuid, $2::uuid) AS ok",
            [workItemId, "00000000-0000-4000-8000-000000000099"],
          );
          expect(renewed.rows[0]?.ok).toBe(0);
          const crashingStore = {
            async delete(ref: string) {
              await secretStore.delete(ref);
              throw new Error("crash");
            },
          };
          await expect(
            performCredentialCleanup({ pool: worker, secretStore: crashingStore }, workItemId),
          ).rejects.toThrow("credential_cleanup_failed");
          expect(secrets.get("retired-a")).toBe(0);
          expect(secrets.get("current-b")).toBe(1);
          await admin.query(
            `UPDATE queue_private.credential_retirement
         SET leased_until = clock_timestamp() - interval '1 second'
         WHERE id = $1::uuid`,
            [workItemId],
          );
          await performCredentialCleanup({ pool: worker, secretStore }, workItemId);
          expect(deleted).toEqual(["retired-a"]);
          const missing = "00000000-0000-4000-8000-0000000000aa";
          await admin.query(
            `INSERT INTO queue_private.credential_retirement
           (id, installation_id, retired_ref, version, state)
         VALUES ($1::uuid, 'missing-install', 'missing-ref', 1, 'pending')`,
            [missing],
          );
          await expect(
            performCredentialCleanup({ pool: worker, secretStore }, missing),
          ).rejects.toThrow("credential_cleanup_invariant");
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

          await admin.query(
            "SELECT queue_api.register_active_credential('phase1-install-2', 'same-ref')",
          );
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
          const skipped = await worker.query<{ status: string }>(
            "SELECT status FROM queue_api.claim_credential_retirement($1::uuid)",
            [skip.rows[0]?.id],
          );
          expect(skipped.rows).toEqual([{ status: "terminal" }]);
          const skippedState = await admin.query<{ state: string; retired_ref: string | null }>(
            "SELECT state, retired_ref FROM queue_private.credential_retirement WHERE id = $1::uuid",
            [skip.rows[0]?.id],
          );
          expect(skippedState.rows[0]).toEqual({ state: "skipped_current", retired_ref: null });

          const holder = await admin.connect();
          const restorer = await admin.connect();
          try {
            await admin.query(
              "SELECT queue_api.register_active_credential('phase1-lock', 'lock-key')",
            );
            await admin.query(
              `INSERT INTO messaging_installations
             (id, provider, "workspaceId", "workspaceName", "spaceId", "userId", "botId", ciphertext, "createdAt", "updatedAt")
           VALUES ('phase1-lock', 'slack', 'W-lock', 'W', $1, $2, $3, 'lock-key', now(), now())`,
              [spaceId, userId, botId],
            );
            await holder.query("BEGIN");
            await holder.query("SELECT queue_api.lock_credential_fingerprint('lock-key')");
            await holder.query(
              `UPDATE queue_private.credential_fingerprint
           SET state = 'retiring'
           WHERE object_id = queue_api.credential_fingerprint('lock-key')`,
            );
            let settled = false;
            const waiting = restorer.query(
              `INSERT INTO messaging_installations
             (id, provider, "workspaceId", "workspaceName", "spaceId", "userId", "botId", ciphertext, "createdAt", "updatedAt")
           VALUES ('phase1-restore', 'slack', 'W-restore', 'W', $1, $2, $3, 'lock-key', now(), now())`,
              [spaceId, userId, botId],
            );
            const watched = waiting.then(
              (value) => {
                settled = true;
                return value;
              },
              (error: unknown) => {
                settled = true;
                throw error;
              },
            );
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(settled).toBe(false);
            const blocked = await admin.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query LIKE '%phase1-restore%'`,
            );
            expect(blocked.rows[0]?.n).toBe(1);
            await holder.query("COMMIT");
            await expect(watched).rejects.toMatchObject({ code: "23514" });
            const restored = await admin.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM messaging_installations WHERE id = 'phase1-restore'",
            );
            expect(restored.rows[0]?.n).toBe(0);
          } finally {
            await holder.query("ROLLBACK").catch(() => undefined);
            holder.release();
            restorer.release();
          }

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

          const workerRetired = "worker-retired";
          const workerCurrent = "worker-current";
          secrets.set(workerRetired, 1);
          await admin.query(
            "SELECT queue_api.register_active_credential('phase1-worker', $1::text)",
            [workerRetired],
          );
          await admin.query(
            `INSERT INTO messaging_installations
           (id, provider, "workspaceId", "workspaceName", "spaceId", "userId", "botId", ciphertext, "createdAt", "updatedAt")
         VALUES ('phase1-worker', 'slack', 'W-worker', 'W', $1, $2, $3, $4, now(), now())`,
            [spaceId, userId, botId, workerRetired],
          );
          const workerClient = await admin.connect();
          let workerItem = "";
          try {
            await workerClient.query("BEGIN");
            const captured = await workerClient.query<{ id: string }>(
              "SELECT queue_api.capture_current_credential('phase1-worker') AS id",
            );
            workerItem = captured.rows[0]?.id ?? "";
            await workerClient.query(
              "SELECT queue_api.register_active_credential('phase1-worker', $1::text)",
              [workerCurrent],
            );
            await workerClient.query(
              "UPDATE messaging_installations SET ciphertext = $1 WHERE id = 'phase1-worker'",
              [workerCurrent],
            );
            await workerClient.query("SELECT queue_api.enqueue_captured_credential($1::uuid)", [
              workerItem,
            ]);
            await workerClient.query("COMMIT");
          } finally {
            workerClient.release();
          }
          await admin.query(
            `DELETE FROM graphile_worker._private_jobs
         WHERE key IS DISTINCT FROM $1`,
            [`credential-cleanup:${workerItem}`],
          );
          const dummyDir = mkdtempSync(join(tmpdir(), "phase1-dummy-"));
          const dummyFile = join(dummyDir, "secrets.json");
          writeFileSync(
            dummyFile,
            JSON.stringify({
              [workerRetired]: "retired-secret",
              [workerCurrent]: "current-secret",
            }),
          );
          const crashingWorker = startWorkerMain(fresh, freshWorker, dummyFile, { crash: true });
          const crash = await crashingWorker.until(/PHASE1_NEVER_MATCH/);
          expect(crash.code, crash.output).toBe(75);
          expect(JSON.parse(readFileSync(dummyFile, "utf8"))[workerRetired]).toBeUndefined();
          expect(JSON.parse(readFileSync(dummyFile, "utf8"))[workerCurrent]).toBe("current-secret");
          // Operator-assisted recovery: these two updates are manual. They are not
          // autonomous stale-lock reclamation and they are not a cleanup SLA.
          await admin.query(
            `UPDATE graphile_worker._private_jobs SET locked_at = NULL, locked_by = NULL
         WHERE key = $1`,
            [`credential-cleanup:${workerItem}`],
          );
          await admin.query(
            `UPDATE queue_private.credential_retirement
         SET leased_until = clock_timestamp() - interval '1 second'
         WHERE id = $1::uuid`,
            [workerItem],
          );
          const restarted = startWorkerMain(fresh, freshWorker, dummyFile, { crash: false });
          let ackedCount = 1;
          for (let attempt = 0; attempt < 40 && ackedCount !== 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            const acked = await admin.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = $1",
              [`credential-cleanup:${workerItem}`],
            );
            ackedCount = acked.rows[0]?.n ?? 1;
          }
          restarted.stop();
          expect(ackedCount, restarted.output()).toBe(0);
          const currentLeft = await admin.query<{ ciphertext: string }>(
            "SELECT ciphertext FROM messaging_installations WHERE id = 'phase1-worker'",
          );
          expect(currentLeft.rows[0]?.ciphertext).toBe(workerCurrent);
          restarted.stop();
          await admin.query(
            `SELECT graphile_worker.add_job(
           'messaging.credential-cleanup'::text,
           json_build_object('installationId', 'phase1-worker', 'ref', 'legacy-ref'),
           NULL::text, NULL::timestamptz, 5, 'phase1-legacy-startup'::text,
           NULL::integer, NULL::text[], 'replace'::text)`,
          );
          const refused = await runWorkerMain(fresh, freshWorker, dummyFile, { crash: false });
          expect(refused.code, refused.stderr).toBe(1);
          expect(refused.stderr).toContain("legacy jobs are queued");
          const legacyRemains = await admin.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = 'phase1-legacy-startup'",
          );
          expect(legacyRemains.rows[0]?.n).toBe(1);
        } finally {
          await admin.end();
          await api.end();
          await worker.end();
          await created.prisma.$disconnect();
        }
      } finally {
        await success.stop();
      }
    } finally {
      if (!refusalStopped) await refusal.stop();
    }
  },
  180_000,
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

function runMigrate(database: URL, workerUrl: URL, runtimeUrl?: URL) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      "pnpm",
      ["--filter", "@rakazo/api", "db:migrate"],
      {
        cwd: "/workspace",
        env: {
          ...process.env,
          DATABASE_URL: (runtimeUrl ?? database).toString(),
          DATABASE_MIGRATION_URL: database.toString(),
          DATABASE_WORKER_URL: workerUrl.toString(),
        },
      },
      (error, stdout, stderr) => {
        const output = `${stderr}\n${stdout}`.replaceAll(database.toString(), "[database]");
        if (error) reject(new Error(output));
        else resolve();
      },
    );
  });
}

function startWorkerMain(
  database: URL,
  workerUrl: URL,
  dummyFile: string,
  options: { crash: boolean },
) {
  let output = "";
  const child = spawn(
    "/workspace/node_modules/.bin/tsx",
    [
      "src/phase1-cleanup-fixture-main.ts",
      "--secret-file",
      dummyFile,
      ...(options.crash ? ["--crash-after-delete"] : []),
    ],
    {
      cwd: "/workspace/apps/worker",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DATABASE_URL: database.toString(),
        DATABASE_MIGRATION_URL: database.toString(),
        DATABASE_WORKER_URL: workerUrl.toString(),
        PHASE1_DUMMY_SECRET_STORE: "",
        PHASE1_DUMMY_CRASH_AFTER_DELETE: "",
        SANDBOX_PROVIDER: "none",
        AGENT_RUNTIME: "scripted",
        NODE_ENV: "production",
        RAKAZO_ALLOW_DEV_SECRETS: "1",
        DB_POOL_MAX: "8",
        WAKEUP_DRIVER: "",
      },
    },
  );
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  const stop = () => {
    child.kill("SIGTERM");
  };
  const until = (pattern: RegExp) =>
    new Promise<{ code: number | null; output: string }>((resolve) => {
      const timer = setTimeout(() => {
        stop();
        resolve({ code: null, output: redact(output) });
      }, 40_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output: redact(output) });
      });
      const poll = setInterval(() => {
        if (pattern.test(output)) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve({ code: null, output: redact(output) });
        }
      }, 200);
      function redact(value: string) {
        return value
          .replaceAll(database.toString(), "[database]")
          .replaceAll(workerUrl.toString(), "[worker]");
      }
    });
  return {
    until,
    stop,
    output: () =>
      output
        .replaceAll(database.toString(), "[database]")
        .replaceAll(workerUrl.toString(), "[worker]"),
  };
}

function runWorkerMain(
  database: URL,
  workerUrl: URL,
  dummyFile: string,
  options: { crash: boolean },
) {
  const started = startWorkerMain(database, workerUrl, dummyFile, options);
  return started.until(/PHASE1_WAIT_FOR_PROCESS_CLOSE/).then((result) => ({
    code: result.code,
    stderr: result.output,
    stdout: result.output,
  }));
}

async function createFreshDatabase(adminUrl: URL): Promise<URL> {
  const name = `phase1_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const pool = createPool(adminUrl.toString());
  await pool.query(`CREATE DATABASE "${name}"`);
  await pool.end();
  const url = new URL(adminUrl.toString());
  url.pathname = `/${name}`;
  return url;
}

function loginUrl(database: URL, user: string, password: string): URL {
  const url = new URL(database.toString());
  url.username = user;
  url.password = password;
  return url;
}

async function migrationCount(database: URL): Promise<number> {
  const present = await scalar(
    database,
    "SELECT CASE WHEN to_regclass('_prisma_migrations') IS NULL THEN 0 ELSE 1 END AS n",
  );
  if (present === 0) return 0;
  return scalar(database, "SELECT count(*)::int AS n FROM _prisma_migrations");
}

async function scalar(database: URL, sql: string): Promise<number> {
  const pool = createPool(database.toString());
  try {
    const rows = await pool.query<{ n: number }>(sql);
    return rows.rows[0]?.n ?? 0;
  } finally {
    await pool.end();
  }
}

async function seedLegacyQueue(database: URL): Promise<void> {
  await psql(
    database,
    `CREATE SCHEMA queue_private;
     CREATE TABLE queue_private.credential_retirement (
       id uuid PRIMARY KEY,
       installation_id text NOT NULL,
       retired_ref text,
       version integer NOT NULL,
       state text NOT NULL
     );
     INSERT INTO queue_private.credential_retirement (id, installation_id, retired_ref, version, state)
     VALUES
       ('00000000-0000-4000-8000-000000000011', 'legacy', 'pending-ref', 1, 'pending'),
       ('00000000-0000-4000-8000-000000000012', 'legacy', 'leased-ref', 1, 'leased'),
       ('00000000-0000-4000-8000-000000000013', 'legacy', NULL, 1, 'deleted'),
       ('00000000-0000-4000-8000-000000000014', 'legacy', NULL, 1, 'skipped_current');
     CREATE TABLE messaging_installations (id text PRIMARY KEY, ciphertext text);
     INSERT INTO messaging_installations (id, ciphertext) VALUES ('legacy-active', 'active-ref');`,
  );
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

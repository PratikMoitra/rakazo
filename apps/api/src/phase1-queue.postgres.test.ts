// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { execFile } from "node:child_process";
import {
  installQueueBoundary,
  restoreRuntimeQueueGrants,
  revokeRuntimeQueueAccess,
} from "@rakazo/db";
import { expect, it } from "vitest";

const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(migrationUrl);
const sentinel = "phase1-dummy-retired-token";

it.skipIf(!enabled)(
  "separates the API login from queue rows and enqueues credential cleanup by work item id",
  async () => {
    const admin = new URL(migrationUrl!);
    const database = admin.pathname.slice(1);
    await psql(
      admin,
      `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_phase1_api') THEN
          CREATE ROLE rakazo_phase1_api LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'phase1-api-password';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_phase1_worker') THEN
          CREATE ROLE rakazo_phase1_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'phase1-worker-password';
        END IF;
      END $$;
    `,
    );
    await psql(
      admin,
      `GRANT CONNECT ON DATABASE ${database} TO rakazo_phase1_api, rakazo_phase1_worker`,
    );
    await psql(admin, `GRANT rakazo_app TO rakazo_phase1_api`);
    await installQueueBoundary(migrationUrl!, "rakazo_phase1_worker");
    const api = new URL(migrationUrl!);
    api.username = "rakazo_phase1_api";
    api.password = "phase1-api-password";
    const worker = new URL(migrationUrl!);
    worker.username = "rakazo_phase1_worker";
    worker.password = "phase1-worker-password";
    try {
      await revokeRuntimeQueueAccess(migrationUrl!);
      for (const statement of [
        "SELECT id FROM graphile_worker._private_jobs",
        "UPDATE graphile_worker._private_jobs SET attempts = attempts",
        "DELETE FROM graphile_worker._private_jobs",
        "INSERT INTO graphile_worker._private_jobs DEFAULT VALUES",
        "TRUNCATE graphile_worker._private_jobs",
        "SELECT graphile_worker.add_job('run.continue'::text, '{}'::json)",
        "SET ROLE rakazo_phase1_worker",
        "SET ROLE rakazo_queue_owner",
        "SELECT retired_ref FROM queue_private.credential_tombstone",
      ]) {
        const denied = await psql(api, statement);
        expect(denied.ok, statement).toBe(false);
        expect(denied.text.toLowerCase()).toContain("permission denied");
      }
      const created = await psql(
        api,
        `SELECT queue_api.create_credential_cleanup('install-phase1', '${sentinel}')`,
      );
      expect(created.ok).toBe(true);
      const workItemId = created.text.trim().split("\n").at(-1)?.trim() ?? "";
      expect(workItemId).toMatch(/^[0-9a-f-]{36}$/);
      const payload = await psql(
        worker,
        `SELECT (payload::jsonb - 'workItemId') = '{}'::jsonb AS only_id
         FROM graphile_worker._private_jobs WHERE key = 'credential-cleanup:${workItemId}'`,
      );
      expect(payload.ok).toBe(true);
      expect(payload.text).toContain("t");
      const matched = await psql(
        worker,
        `SELECT sha256(retired_ref::bytea) = sha256('${sentinel}'::bytea) AS same
         FROM queue_api.claim_retired_credential('${workItemId}'::uuid, 'different-current')`,
      );
      expect(matched.text).toContain("t");
      expect(matched.text).not.toContain(sentinel);
      await psql(worker, `SELECT queue_api.complete_credential_cleanup('${workItemId}'::uuid)`);
      const again = await psql(
        worker,
        `SELECT count(*) FROM queue_api.claim_retired_credential('${workItemId}'::uuid, 'different-current')`,
      );
      expect(again.text).toContain("0");
      const second = await psql(
        api,
        `SELECT queue_api.create_credential_cleanup('install-phase1-current', '${sentinel}')`,
      );
      const secondId = second.text.trim().split("\n").at(-1)?.trim() ?? "";
      await psql(
        worker,
        `SELECT queue_api.claim_retired_credential('${secondId}'::uuid, '${sentinel}')`,
      );
      const skipped = await psql(
        admin,
        `SELECT state = 'skipped_current' AS skipped FROM queue_private.credential_tombstone WHERE work_item_id = '${secondId}'::uuid`,
      );
      expect(skipped.text).toContain("t");
      await psql(
        worker,
        `UPDATE graphile_worker._private_jobs SET last_error = '${sentinel}-error' WHERE key = 'credential-cleanup:${workItemId}'`,
      );
      await psql(worker, `SELECT queue_api.redact_dispatch_errors()`);
      const redacted = await psql(
        worker,
        `SELECT last_error = 'redacted' AS redacted FROM graphile_worker._private_jobs WHERE key = 'credential-cleanup:${workItemId}'`,
      );
      expect(redacted.text).toContain("t");
      expect(redacted.text).not.toContain(sentinel);
      const beforeJobs = await psql(
        admin,
        `SELECT count(*) AS n FROM graphile_worker._private_jobs WHERE key = 'phase1-legacy-locked'`,
      );
      await psql(
        admin,
        `SELECT graphile_worker.add_job('messaging.credential-cleanup'::text, json_build_object('ref', '${sentinel}'), NULL::text, NULL::timestamptz, 5, 'phase1-legacy-locked'::text)`,
      );
      await psql(
        admin,
        `INSERT INTO queue_private.legacy_fixture (task, payload, last_error, locked, attempts, max_attempts)
         VALUES
         ('messaging.credential-cleanup', json_build_object('installationId', 'install-locked', 'ref', '${sentinel}'), '${sentinel}-error', true, 1, 5),
         ('messaging.credential-cleanup', json_build_object('installationId', 'install-failed', 'ref', '${sentinel}'), '${sentinel}-error', false, 5, 5),
         ('messaging.credential-cleanup', '{"installationId":"missing"}'::jsonb, '${sentinel}-error', false, 5, 5)`,
      );
      const rehearsed = await psql(
        worker,
        `SELECT converted::text || ',' || quarantined::text || ',' || unresolved::text
         FROM queue_api.rehearse_legacy_fixtures()`,
      );
      expect(rehearsed.ok).toBe(true);
      expect(rehearsed.text).toContain("1,1,1");
      const afterJobs = await psql(
        admin,
        `SELECT count(*) AS n FROM graphile_worker._private_jobs WHERE key = 'phase1-legacy-locked'`,
      );
      expect(afterJobs.text).toContain("1");
      expect(beforeJobs.text).toContain("0");
      const kept = await psql(
        admin,
        `SELECT
           (bool_or(locked) AND bool_or(locked AND payload ? 'ref'))::text
           || ',' ||
           coalesce(bool_or(NOT locked AND payload ? 'ref'), false)::text
           || ',' ||
           (count(*) FILTER (WHERE NOT locked AND NOT payload ? 'ref') > 0)::text
         FROM queue_private.legacy_fixture`,
      );
      expect(kept.text).toContain("true,false,true");
    } finally {
      await psql(admin, `DELETE FROM queue_private.legacy_fixture`).catch?.(() => undefined);
      await restoreRuntimeQueueGrants(migrationUrl!).catch(() => undefined);
    }
  },
  120_000,
);

function psql(url: URL, sql: string) {
  return new Promise<{ ok: boolean; text: string }>((resolve) => {
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
        "-t",
        "-A",
        "-c",
        sql,
      ],
      { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) } },
      (error, stdout, stderr) => {
        resolve({ ok: !error, text: `${stdout}\n${stderr}` });
      },
    );
  });
}

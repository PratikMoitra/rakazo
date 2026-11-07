// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { scramSha256Verifier } from "./database-access.js";

const QUEUE_OWNER = "rakazo_queue_owner";
/** How long one worker may hold a retirement while it calls the secret store. */
export const CREDENTIAL_RETIREMENT_LEASE_SECONDS = 5;
/** Redacted retirement rows are removed after this many days. */
export const CREDENTIAL_RETIREMENT_RETENTION_DAYS = 7;

/**
 * Other background jobs still use the runtime login's Graphile grants. This
 * module does not revoke those grants. Credential cleanup is the only job
 * that has a private retirement record.
 *
 * The definer is rakazo_queue_owner: NOLOGIN, NOSUPERUSER, NOBYPASSRLS. It is
 * not the migration role. API is not a member of it. The functions do not take
 * a credential reference; they copy the reference stored on the installation.
 */
export function credentialWorkerTarget(
  databaseUrl: string,
  workerUrl: string | undefined,
): { mode: "off" } | { mode: "on"; url: string; login: string } {
  if (workerUrl === undefined) return { mode: "off" };
  if (workerUrl.trim() === "") throw new Error("DATABASE_WORKER_URL is blank");
  const workerLogin = loginOf(workerUrl);
  const runtimeLogin = loginOf(databaseUrl);
  if (!workerLogin) throw new Error("DATABASE_WORKER_URL must name a login");
  if (workerLogin === runtimeLogin) {
    throw new Error("DATABASE_WORKER_URL must not use the same login as DATABASE_URL");
  }
  return { mode: "on", url: workerUrl.trim(), login: workerLogin };
}

export async function installQueueBoundary(migrationUrl: string): Promise<void> {
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    const ready = await owner.query<{ ready: boolean }>(
      "SELECT to_regclass('graphile_worker._private_jobs') IS NOT NULL AS ready",
    );
    if (!ready.rows[0]?.ready) throw new Error("queue boundary needs the job schema");
    await owner.query(BOUNDARY_SQL);
    await grantDefinerQueueAccess(owner);
  } finally {
    await owner.end();
  }
}

/** Creates the worker login named by DATABASE_WORKER_URL and grants only cleanup execution. */
export async function provisionCredentialWorker(
  migrationUrl: string,
  workerUrl: string,
): Promise<void> {
  const parsed = new URL(workerUrl);
  const login = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(login)) throw new Error("invalid worker login");
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    const secret = password ? `PASSWORD ${escapeLiteral(scramSha256Verifier(password))}` : "";
    const name = escapeIdentifier(login);
    const existing = await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [login]);
    if (!existing.rowCount) {
      await owner.query(
        `CREATE ROLE ${name} LOGIN ${secret} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    } else {
      await owner.query(
        `ALTER ROLE ${name} LOGIN ${secret} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    }
    await owner.query(
      `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${name}', current_database()); END $$`,
    );
    await owner.query(`GRANT USAGE ON SCHEMA queue_api, graphile_worker TO ${name}`);
    await owner.query(`
      GRANT EXECUTE ON FUNCTION
        queue_api.claim_credential_retirement(uuid),
        queue_api.complete_credential_retirement(uuid, uuid),
        queue_api.redact_dispatch_errors(),
        queue_api.purge_redacted_retirements(integer)
      TO ${name}
    `);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO ${name}`,
    );
    await owner.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA graphile_worker TO ${name}`,
    );
    await owner.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO ${name}`);
    await grantQueuePolicy(owner, "rakazo_credential_worker", login);
    await owner.query(`
      REVOKE EXECUTE ON FUNCTION
        queue_api.claim_credential_retirement(uuid),
        queue_api.complete_credential_retirement(uuid, uuid),
        queue_api.redact_dispatch_errors(),
        queue_api.purge_redacted_retirements(integer)
      FROM PUBLIC, rakazo_app
    `);
  } finally {
    await owner.end();
  }
}

export async function countLegacyCredentialJobs(query: {
  query: (sql: string) => Promise<{ rows: Array<{ n: number }> }>;
}): Promise<number> {
  const found = await query.query(`
    SELECT count(*)::int AS n
    FROM graphile_worker._private_jobs AS jobs
    JOIN graphile_worker._private_tasks AS tasks ON tasks.id = jobs.task_id
    WHERE tasks.identifier = 'messaging.credential-cleanup'
      AND jobs.payload::text LIKE '%"ref"%'
      AND jobs.payload::text NOT LIKE '%"workItemId"%'
  `);
  return found.rows[0]?.n ?? 0;
}

async function grantDefinerQueueAccess(owner: Client): Promise<void> {
  await owner.query(`
    GRANT USAGE ON SCHEMA graphile_worker, public, queue_private, queue_api TO ${QUEUE_OWNER};
    GRANT SELECT, UPDATE ON TABLE messaging_installations TO ${QUEUE_OWNER};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA queue_private TO ${QUEUE_OWNER};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO ${QUEUE_OWNER};
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA graphile_worker TO ${QUEUE_OWNER};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO ${QUEUE_OWNER};
  `);
  await grantQueuePolicy(owner, "rakazo_queue_definer", QUEUE_OWNER);
  await owner.query(`
    DROP POLICY IF EXISTS rakazo_queue_owner_installation ON messaging_installations;
    CREATE POLICY rakazo_queue_owner_installation ON messaging_installations
      FOR ALL TO ${QUEUE_OWNER} USING (true) WITH CHECK (true);
  `);
  for (const name of [
    "capture_current_credential(text)",
    "enqueue_captured_credential(uuid)",
    "claim_credential_retirement(uuid)",
    "complete_credential_retirement(uuid, uuid)",
    "redact_dispatch_errors()",
    "purge_redacted_retirements(integer)",
  ]) {
    await owner.query(`ALTER FUNCTION queue_api.${name} OWNER TO ${QUEUE_OWNER}`);
  }
}

async function grantQueuePolicy(owner: Client, policy: string, role: string): Promise<void> {
  const tables = await owner.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c
     WHERE c.relnamespace = 'graphile_worker'::regnamespace AND c.relrowsecurity`,
  );
  for (const table of tables.rows) {
    if (!/^[A-Za-z0-9_]+$/.test(table.name)) continue;
    await owner.query(`DROP POLICY IF EXISTS ${policy} ON graphile_worker.${table.name}`);
    await owner.query(
      `CREATE POLICY ${policy} ON graphile_worker.${table.name}
       FOR ALL TO ${role} USING (true) WITH CHECK (true)`,
    );
  }
}

function loginOf(url: string): string {
  return decodeURIComponent(new URL(url).username);
}

const BOUNDARY_SQL = `
CREATE SCHEMA IF NOT EXISTS queue_private;
CREATE SCHEMA IF NOT EXISTS queue_api;
REVOKE ALL ON SCHEMA queue_private FROM PUBLIC;
REVOKE ALL ON SCHEMA queue_api FROM PUBLIC;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${QUEUE_OWNER}') THEN
    CREATE ROLE ${QUEUE_OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE ${QUEUE_OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

DROP FUNCTION IF EXISTS queue_api.create_credential_cleanup(text, text);
DROP FUNCTION IF EXISTS queue_api.credential_installation(uuid);
DROP FUNCTION IF EXISTS queue_api.claim_retired_credential(uuid, text);
DROP FUNCTION IF EXISTS queue_api.complete_credential_cleanup(uuid);
DROP FUNCTION IF EXISTS queue_api.rehearse_legacy_fixtures();
DROP TABLE IF EXISTS queue_private.legacy_fixture;
DROP TABLE IF EXISTS queue_private.credential_tombstone;
DROP TABLE IF EXISTS queue_private.work_item;

CREATE TABLE IF NOT EXISTS queue_private.credential_retirement (
  id uuid PRIMARY KEY,
  installation_id text NOT NULL,
  retired_ref text,
  version integer NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  lease_fence uuid,
  leased_until timestamptz,
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_retirement_state_check
    CHECK (state IN ('pending', 'leased', 'deleted', 'skipped_current'))
);
ALTER TABLE queue_private.credential_retirement OWNER TO ${QUEUE_OWNER};
REVOKE ALL ON TABLE queue_private.credential_retirement FROM PUBLIC, rakazo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA queue_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA queue_private REVOKE ALL ON TABLES FROM PUBLIC;

CREATE OR REPLACE FUNCTION queue_api.capture_current_credential(installation_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  current_ref text;
  next_version integer;
  item_id uuid := gen_random_uuid();
BEGIN
  IF installation_id IS NULL OR length(installation_id) < 1 OR length(installation_id) > 200 THEN
    RAISE EXCEPTION 'invalid installation' USING ERRCODE = '22023';
  END IF;
  SELECT ciphertext INTO current_ref
  FROM public.messaging_installations
  WHERE id = installation_id
  FOR UPDATE;
  IF current_ref IS NULL OR length(current_ref) < 1 THEN
    RAISE EXCEPTION 'installation has no credential' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(max(version), 0) + 1 INTO next_version
  FROM queue_private.credential_retirement
  WHERE credential_retirement.installation_id = capture_current_credential.installation_id;
  INSERT INTO queue_private.credential_retirement (id, installation_id, retired_ref, version)
  VALUES (item_id, installation_id, current_ref, next_version);
  RETURN item_id;
END
$fn$;

DROP FUNCTION IF EXISTS queue_api.enqueue_captured_credential(uuid);
CREATE OR REPLACE FUNCTION queue_api.enqueue_captured_credential(item_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  stored text;
  installation text;
  current_state text;
  current_ref text;
BEGIN
  SELECT retired_ref, installation_id, state
    INTO stored, installation, current_state
  FROM queue_private.credential_retirement
  WHERE id = item_id
  FOR UPDATE;
  IF installation IS NULL OR current_state <> 'pending' OR stored IS NULL THEN
    RAISE EXCEPTION 'retirement cannot be enqueued' USING ERRCODE = '22023';
  END IF;
  SELECT ciphertext INTO current_ref
  FROM public.messaging_installations
  WHERE id = installation;
  IF current_ref IS NOT NULL AND current_ref = stored THEN
    RAISE EXCEPTION 'retirement is still the current credential' USING ERRCODE = '22023';
  END IF;
  PERFORM graphile_worker.add_job(
    'work.dispatch'::text,
    json_build_object('workItemId', item_id)::json,
    NULL::text,
    NULL::timestamptz,
    20,
    ('credential-cleanup:' || item_id::text)::text,
    NULL::integer,
    NULL::text[],
    'replace'::text
  );
  RETURN 1;
END
$fn$;

CREATE OR REPLACE FUNCTION queue_api.claim_credential_retirement(item_id uuid)
RETURNS TABLE (installation_id text, retired_ref text, fence uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  stored text;
  inst text;
  current_state text;
  current_ref text;
  held_until timestamptz;
  next_fence uuid := gen_random_uuid();
BEGIN
  SELECT retirement.retired_ref, retirement.installation_id, retirement.state, retirement.leased_until
    INTO stored, inst, current_state, held_until
  FROM queue_private.credential_retirement AS retirement
  WHERE retirement.id = item_id
  FOR UPDATE;
  IF inst IS NULL OR stored IS NULL OR current_state IN ('deleted', 'skipped_current') THEN
    RETURN;
  END IF;
  IF current_state = 'leased' AND held_until IS NOT NULL AND held_until > clock_timestamp() THEN
    RETURN;
  END IF;
  SELECT ciphertext INTO current_ref
  FROM public.messaging_installations
  WHERE id = inst;
  IF current_ref IS NOT NULL AND current_ref = stored THEN
    UPDATE queue_private.credential_retirement
    SET state = 'skipped_current', retired_ref = NULL, redacted_at = clock_timestamp(),
        lease_fence = NULL, leased_until = NULL
    WHERE id = item_id;
    RETURN;
  END IF;
  UPDATE queue_private.credential_retirement
  SET state = 'leased', lease_fence = next_fence,
      leased_until = clock_timestamp() + make_interval(secs => ${CREDENTIAL_RETIREMENT_LEASE_SECONDS})
  WHERE id = item_id;
  installation_id := inst;
  retired_ref := stored;
  fence := next_fence;
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION queue_api.complete_credential_retirement(item_id uuid, fence uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  updated integer;
BEGIN
  UPDATE queue_private.credential_retirement
  SET state = 'deleted', retired_ref = NULL, redacted_at = clock_timestamp(),
      lease_fence = NULL, leased_until = NULL
  WHERE id = item_id AND state = 'leased' AND lease_fence = fence;
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated = 1 THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM queue_private.credential_retirement
    WHERE id = item_id AND state = 'deleted' AND retired_ref IS NULL
  ) THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'retirement fence mismatch' USING ERRCODE = '22023';
END
$fn$;

CREATE OR REPLACE FUNCTION queue_api.redact_dispatch_errors()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  changed integer;
BEGIN
  UPDATE graphile_worker._private_jobs AS jobs
  SET last_error = 'redacted'
  WHERE jobs.payload::text LIKE '%workItemId%'
    AND jobs.last_error IS NOT NULL
    AND jobs.last_error NOT IN ('credential_cleanup_failed', 'work_rejected', 'redacted');
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$fn$;

CREATE OR REPLACE FUNCTION queue_api.purge_redacted_retirements(retention_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  removed integer;
BEGIN
  IF retention_days IS NULL OR retention_days < 0 OR retention_days > 3650 THEN
    RAISE EXCEPTION 'invalid retention' USING ERRCODE = '22023';
  END IF;
  DELETE FROM queue_private.credential_retirement
  WHERE state IN ('deleted', 'skipped_current')
    AND retired_ref IS NULL
    AND redacted_at IS NOT NULL
    AND redacted_at < clock_timestamp() - make_interval(days => retention_days);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA queue_api FROM PUBLIC;
GRANT USAGE ON SCHEMA queue_api TO rakazo_app;
GRANT EXECUTE ON FUNCTION
  queue_api.capture_current_credential(text),
  queue_api.enqueue_captured_credential(uuid)
TO rakazo_app;
`;

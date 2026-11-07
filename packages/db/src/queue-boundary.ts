// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { Client } from "pg";

/**
 * The API login may call queue_api.create_credential_cleanup. That is trusted
 * application code, not a tenant SQL session: a tenant id is not an argument
 * and is not turned into system authority. The function stores the retired
 * reference in queue_private and enqueues only {workItemId}. It does not grant
 * the API login raw Graphile access. Callers must not log the reference.
 * rakazo_queue_owner owns the protected tables. The functions stay owned by
 * the migration role, which owns the Graphile tables, so enqueue is not blocked
 * by the runtime row policy. The function body does not accept a task name,
 * raw payload, or caller search path.
 *
 * Other background jobs still enqueue through Graphile as the runtime login.
 * Those grants stay until that publisher moves. Removing them in this migration
 * would stop the previous release during a rolling deploy.
 */
export async function installQueueBoundary(
  migrationUrl: string,
  workerLogin?: string,
): Promise<void> {
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    const ready = await owner.query<{ ready: boolean }>(
      "SELECT to_regclass('graphile_worker._private_jobs') IS NOT NULL AS ready",
    );
    if (!ready.rows[0]?.ready) throw new Error("queue boundary needs the job schema");
    await owner.query(BOUNDARY_SQL);
    if (workerLogin) {
      const tables = await owner.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c
         WHERE c.relnamespace = 'graphile_worker'::regnamespace AND c.relrowsecurity`,
      );
      for (const table of tables.rows) {
        const qualified = `graphile_worker.${quoteIdent(table.name)}`;
        await owner.query(`DROP POLICY IF EXISTS rakazo_worker_queue ON ${qualified}`);
        await owner.query(
          `CREATE POLICY rakazo_worker_queue ON ${qualified} FOR ALL TO ${quoteIdent(workerLogin)} USING (true) WITH CHECK (true)`,
        );
      }
      await owner.query(`GRANT USAGE ON SCHEMA queue_api TO ${quoteIdent(workerLogin)}`);
      await owner.query(
        `GRANT EXECUTE ON FUNCTION queue_api.credential_installation(uuid), queue_api.claim_retired_credential(uuid, text), queue_api.complete_credential_cleanup(uuid), queue_api.redact_dispatch_errors(), queue_api.rehearse_legacy_fixtures() TO ${quoteIdent(workerLogin)}`,
      );
      await owner.query(`GRANT USAGE ON SCHEMA graphile_worker TO ${quoteIdent(workerLogin)}`);
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO ${quoteIdent(workerLogin)}`,
      );
      await owner.query(
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA graphile_worker TO ${quoteIdent(workerLogin)}`,
      );
      await owner.query(
        `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO ${quoteIdent(workerLogin)}`,
      );
    }
  } finally {
    await owner.end();
  }
}

/** Disposable rehearsal of the post-cutover API denial. Not applied on deploy. */
export async function revokeRuntimeQueueAccess(migrationUrl: string): Promise<void> {
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    await owner.query(`
      REVOKE ALL ON SCHEMA graphile_worker FROM rakazo_app, PUBLIC;
      REVOKE ALL ON ALL TABLES IN SCHEMA graphile_worker FROM rakazo_app, PUBLIC;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA graphile_worker FROM rakazo_app, PUBLIC;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA graphile_worker FROM rakazo_app, PUBLIC;
    `);
    const tables = await owner.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
       WHERE c.relnamespace = 'graphile_worker'::regnamespace AND c.relrowsecurity`,
    );
    for (const table of tables.rows) {
      await owner.query(
        `DROP POLICY IF EXISTS rakazo_app_queue ON graphile_worker.${quoteIdent(table.name)}`,
      );
    }
  } finally {
    await owner.end();
  }
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("invalid role");
  return `"${name}"`;
}

const BOUNDARY_SQL = `
CREATE SCHEMA IF NOT EXISTS queue_private;
CREATE SCHEMA IF NOT EXISTS queue_api;
REVOKE ALL ON SCHEMA queue_private FROM PUBLIC;
REVOKE ALL ON SCHEMA queue_api FROM PUBLIC;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_queue_owner') THEN
    CREATE ROLE rakazo_queue_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS queue_private.work_item (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  entity jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_work_item_kind_check CHECK (kind = 'messaging.credential-cleanup'),
  CONSTRAINT queue_work_item_entity_check CHECK (entity ? 'tombstoneId' AND NOT entity ? 'ref')
);

CREATE TABLE IF NOT EXISTS queue_private.credential_tombstone (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL UNIQUE REFERENCES queue_private.work_item(id),
  installation_id text NOT NULL,
  retired_ref text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  CONSTRAINT credential_tombstone_state_check CHECK (state IN ('pending', 'deleted', 'skipped_current'))
);

CREATE TABLE IF NOT EXISTS queue_private.legacy_fixture (
  id bigserial PRIMARY KEY,
  task text NOT NULL,
  payload jsonb NOT NULL,
  last_error text,
  locked boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1
);

REVOKE ALL ON ALL TABLES IN SCHEMA queue_private FROM PUBLIC, rakazo_app;
GRANT USAGE ON SCHEMA queue_private, queue_api, graphile_worker TO rakazo_queue_owner;
GRANT ALL ON ALL TABLES IN SCHEMA queue_private TO rakazo_queue_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO rakazo_queue_owner;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO rakazo_queue_owner;

CREATE OR REPLACE FUNCTION queue_api.create_credential_cleanup(installation_id text, retired_ref text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  item_id uuid := gen_random_uuid();
  tomb_id uuid := gen_random_uuid();
BEGIN
  IF installation_id IS NULL OR length(installation_id) < 1 OR length(installation_id) > 200 THEN
    RAISE EXCEPTION 'invalid installation' USING ERRCODE = '22023';
  END IF;
  IF retired_ref IS NULL OR length(retired_ref) < 1 OR length(retired_ref) > 2000 THEN
    RAISE EXCEPTION 'invalid credential reference' USING ERRCODE = '22023';
  END IF;
  INSERT INTO queue_private.work_item (id, kind, entity)
  VALUES (item_id, 'messaging.credential-cleanup', jsonb_build_object('tombstoneId', tomb_id));
  INSERT INTO queue_private.credential_tombstone (id, work_item_id, installation_id, retired_ref)
  VALUES (tomb_id, item_id, installation_id, retired_ref);
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
  RETURN item_id;
END
$fn$;

CREATE OR REPLACE FUNCTION queue_api.credential_installation(item_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
  SELECT installation_id FROM queue_private.credential_tombstone WHERE work_item_id = item_id
$fn$;

CREATE OR REPLACE FUNCTION queue_api.claim_retired_credential(item_id uuid, current_ciphertext text)
RETURNS TABLE (installation_id text, retired_ref text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  inst text;
  stored text;
  current_state text;
BEGIN
  SELECT tomb.installation_id, tomb.retired_ref, tomb.state
    INTO inst, stored, current_state
  FROM queue_private.credential_tombstone AS tomb
  WHERE tomb.work_item_id = item_id
  FOR UPDATE;
  IF inst IS NULL OR current_state <> 'pending' THEN
    RETURN;
  END IF;
  IF current_ciphertext IS NOT NULL AND stored = current_ciphertext THEN
    UPDATE queue_private.credential_tombstone
    SET state = 'skipped_current'
    WHERE work_item_id = item_id AND state = 'pending';
    RETURN;
  END IF;
  installation_id := inst;
  retired_ref := stored;
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION queue_api.complete_credential_cleanup(item_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
  UPDATE queue_private.credential_tombstone
  SET state = 'deleted'
  WHERE work_item_id = item_id AND state = 'pending'
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

CREATE OR REPLACE FUNCTION queue_api.rehearse_legacy_fixtures()
RETURNS TABLE (converted integer, quarantined integer, unresolved integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  converted_count integer := 0;
  quarantined_count integer := 0;
  unresolved_count integer := 0;
  fixture record;
  item_id uuid;
  tomb_id uuid;
BEGIN
  FOR fixture IN SELECT * FROM queue_private.legacy_fixture ORDER BY id LOOP
    IF fixture.locked THEN
      quarantined_count := quarantined_count + 1;
      CONTINUE;
    END IF;
    IF fixture.task <> 'messaging.credential-cleanup'
      OR coalesce(fixture.payload->>'ref', '') = '' THEN
      unresolved_count := unresolved_count + 1;
      CONTINUE;
    END IF;
    item_id := gen_random_uuid();
    tomb_id := gen_random_uuid();
    INSERT INTO queue_private.work_item (id, kind, entity)
    VALUES (item_id, 'messaging.credential-cleanup', jsonb_build_object('tombstoneId', tomb_id));
    INSERT INTO queue_private.credential_tombstone (id, work_item_id, installation_id, retired_ref)
    VALUES (
      tomb_id,
      item_id,
      coalesce(fixture.payload->>'installationId', 'unknown'),
      fixture.payload->>'ref'
    );
    UPDATE queue_private.legacy_fixture
    SET payload = jsonb_build_object('workItemId', item_id),
        last_error = CASE WHEN last_error IS NULL THEN NULL ELSE 'redacted' END
    WHERE id = fixture.id;
    converted_count := converted_count + 1;
  END LOOP;
  converted := converted_count;
  quarantined := quarantined_count;
  unresolved := unresolved_count;
  RETURN NEXT;
END
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA queue_api FROM PUBLIC;
GRANT USAGE ON SCHEMA queue_api TO rakazo_app;
GRANT EXECUTE ON FUNCTION queue_api.create_credential_cleanup(text, text) TO rakazo_app;
ALTER SCHEMA queue_private OWNER TO rakazo_queue_owner;
ALTER TABLE queue_private.work_item OWNER TO rakazo_queue_owner;
ALTER TABLE queue_private.credential_tombstone OWNER TO rakazo_queue_owner;
ALTER TABLE queue_private.legacy_fixture OWNER TO rakazo_queue_owner;
`;

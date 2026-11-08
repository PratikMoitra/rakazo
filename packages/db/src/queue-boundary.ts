// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { scramSha256Verifier } from "./database-access.js";

const QUEUE_OWNER = "rakazo_queue_owner";
/** The only login `pnpm db:migrate` will create for credential cleanup. */
export const MANAGED_CREDENTIAL_WORKER = "rakazo_credential_worker";
/** Longer than the external delete deadline in performCredentialCleanup. */
export const CREDENTIAL_RETIREMENT_LEASE_SECONDS = 30;
export const CREDENTIAL_DELETE_TIMEOUT_MS = 10_000;
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
  if (workerLogin !== MANAGED_CREDENTIAL_WORKER) {
    throw new Error("DATABASE_WORKER_URL must use the managed credential worker login");
  }
  return { mode: "on", url: workerUrl.trim(), login: workerLogin };
}

/**
 * Read-only. Call before migrations or role changes. A rejected config does not
 * ALTER roles. Raw-ref legacy jobs are counted by countLegacyCredentialJobs and
 * are not deleted here.
 */
export interface CredentialWorkerConnection {
  connect(): Promise<unknown>;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

/**
 * Compares the worker URL's host, port, and database with the migration URL.
 * It does not open a connection and does not copy migration authentication
 * onto another host. A different host fails closed, including aliases that
 * would require a network lookup to confirm.
 */
export function assertPinnedWorkerEndpoint(migrationUrl: string, workerUrl: string): void {
  const migration = parsedEndpoint(migrationUrl);
  const worker = parsedEndpoint(workerUrl);
  if (!migration || !worker || migration !== worker) {
    throw new Error("DATABASE_WORKER_URL is not the trusted migration endpoint");
  }
}

/** Migration authentication is never aimed at the worker-configured host. */
export function migrationAuthProbe(): null {
  return null;
}

function parsedEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!url.hostname || !database) return undefined;
    return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}`;
  } catch {
    return undefined;
  }
}

function openMigrationClient(connectionString: string): CredentialWorkerConnection {
  return new Client({ connectionString });
}

export async function preflightCredentialWorker(
  migrationUrl: string,
  workerUrl: string,
  open: (connectionString: string) => CredentialWorkerConnection = openMigrationClient,
): Promise<void> {
  const target = credentialWorkerTarget(migrationUrl, workerUrl);
  if (target.mode !== "on") return;
  assertPinnedWorkerEndpoint(migrationUrl, workerUrl);
  const workerDatabase = databaseName(workerUrl);
  const owner = open(migrationUrl);
  await owner.connect();
  try {
    const [here] = (
      await owner.query<{ db: string; session_user: string; owner_name: string }>(`
        SELECT current_database() AS db, session_user,
          pg_catalog.pg_get_userbyid(d.datdba) AS owner_name
        FROM pg_catalog.pg_database AS d
        WHERE d.datname = current_database()
      `)
    ).rows;
    if (!here || here.db !== workerDatabase) {
      throw new Error("DATABASE_WORKER_URL must use the same database as the migration");
    }
    const reserved = new Set([QUEUE_OWNER, "rakazo_app", here.session_user, here.owner_name]);
    if (reserved.has(target.login)) {
      throw new Error("DATABASE_WORKER_URL uses a reserved database identity");
    }
    const [role] = (
      await owner.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        member_of_owner: boolean;
      }>(
        `SELECT r.rolsuper, r.rolbypassrls, r.rolcanlogin, r.rolcreatedb, r.rolcreaterole,
           CASE
             WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2)
               THEN pg_has_role(r.rolname, $2, 'MEMBER')
             ELSE false
           END AS member_of_owner
         FROM pg_roles AS r WHERE r.rolname = $1`,
        [target.login, QUEUE_OWNER],
      )
    ).rows;
    if (!role) return;
    const provenance = await owner.query<{ ok: boolean }>(
      "SELECT to_regclass('queue_private.worker_provenance') IS NOT NULL AS ok",
    );
    const [marked] = provenance.rows[0]?.ok
      ? (
          await owner.query<{ role_oid: string }>(
            `SELECT role_oid::text FROM queue_private.worker_provenance WHERE role_name = $1`,
            [target.login],
          )
        ).rows
      : [];
    const [oid] = (
      await owner.query<{ id: string }>("SELECT oid::text AS id FROM pg_roles WHERE rolname = $1", [
        target.login,
      ])
    ).rows;
    if (!marked || marked.role_oid !== oid?.id) {
      throw new Error("DATABASE_WORKER_URL names an unrelated preexisting role");
    }
    const memberships = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_auth_members WHERE member = $1::oid OR roleid = $1::oid`,
      [oid?.id],
    );
    const owns = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relowner = $1::oid AND relkind IN ('r','p','v','m','S','f')`,
      [oid?.id],
    );
    if ((memberships.rows[0]?.n ?? 0) > 0 || (owns.rows[0]?.n ?? 0) > 0) {
      throw new Error(
        "DATABASE_WORKER_URL role has memberships or ownership this command will not change",
      );
    }
    if (
      role.rolsuper ||
      role.rolbypassrls ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      !role.rolcanlogin ||
      role.member_of_owner
    ) {
      throw new Error("DATABASE_WORKER_URL names a role this migrate command will not alter");
    }
  } finally {
    await owner.end();
  }
}

function incompatible(counts: {
  tombstones: number;
  workItems: number;
  fixtures: number;
  opaqueJobs: number;
  retirementWithoutRegistry: number;
  activeWithoutRegistry: number;
  rawRegistry: number;
}): boolean {
  return (
    counts.tombstones +
      counts.workItems +
      counts.fixtures +
      counts.opaqueJobs +
      counts.retirementWithoutRegistry +
      counts.activeWithoutRegistry +
      counts.rawRegistry >
    0
  );
}

function refusal(counts: {
  tombstones: number;
  workItems: number;
  fixtures: number;
  opaqueJobs: number;
  retirementWithoutRegistry: number;
  activeWithoutRegistry: number;
  rawRegistry: number;
}): string {
  return `credential cleanup upgrade refused: tombstones=${counts.tombstones} workItems=${counts.workItems} fixtures=${counts.fixtures} opaqueJobs=${counts.opaqueJobs} retirementWithoutRegistry=${counts.retirementWithoutRegistry} activeWithoutRegistry=${counts.activeWithoutRegistry} rawRegistry=${counts.rawRegistry}`;
}

/** Counts only. Does not delete or rewrite jobs. A nonzero count must refuse startup. */
export async function preflightQueueBoundary(migrationUrl: string): Promise<{
  tombstones: number;
  workItems: number;
  fixtures: number;
  opaqueJobs: number;
}> {
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    const counts = await legacyQueueCounts(owner);
    if (incompatible(counts)) throw new Error(refusal(counts));
    return counts;
  } finally {
    await owner.end();
  }
}

export async function installQueueBoundary(migrationUrl: string): Promise<void> {
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    const ready = await owner.query<{ ready: boolean }>(
      "SELECT to_regclass('graphile_worker._private_jobs') IS NOT NULL AS ready",
    );
    if (!ready.rows[0]?.ready) throw new Error("queue boundary needs the job schema");
    const prior = await legacyQueueCounts(owner);
    if (incompatible(prior)) throw new Error(refusal(prior));
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
  if (login !== MANAGED_CREDENTIAL_WORKER) {
    throw new Error("DATABASE_WORKER_URL must use the managed credential worker login");
  }
  const owner = new Client({ connectionString: migrationUrl });
  await owner.connect();
  try {
    await preflightCredentialWorker(migrationUrl, workerUrl);
    const secret = password ? `PASSWORD ${escapeLiteral(scramSha256Verifier(password))}` : "";
    const name = escapeIdentifier(login);
    const existing = await owner.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = $1",
      [login],
    );
    if (!existing.rowCount) {
      await owner.query(
        `CREATE ROLE ${name} LOGIN ${secret} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await owner.query(
        `INSERT INTO queue_private.worker_provenance (role_name, role_oid)
         SELECT $1::text, oid FROM pg_roles WHERE rolname = $1::text
         ON CONFLICT (role_name) DO UPDATE SET role_oid = EXCLUDED.role_oid`,
        [login],
      );
    } else if (existing.rows[0]?.rolcanlogin) {
      await owner.query(
        `ALTER ROLE ${name} PASSWORD ${escapeLiteral(scramSha256Verifier(password))}`,
      );
    } else {
      throw new Error("DATABASE_WORKER_URL names a role this migrate command will not alter");
    }
    await owner.query(
      `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${name}', current_database()); END $$`,
    );
    await owner.query(`GRANT USAGE ON SCHEMA queue_api, graphile_worker TO ${name}`);
    await owner.query(`
      GRANT EXECUTE ON FUNCTION
        queue_api.claim_credential_retirement(uuid),
        queue_api.renew_credential_lease(uuid, uuid),
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
        queue_api.renew_credential_lease(uuid, uuid),
        queue_api.complete_credential_retirement(uuid, uuid),
        queue_api.redact_dispatch_errors(),
        queue_api.purge_redacted_retirements(integer)
      FROM PUBLIC, rakazo_app
    `);
    await attestCredentialWorker(migrationUrl, workerUrl);
  } finally {
    await owner.end();
  }
}

/** After bootstrap, the worker login itself must land on the pinned database. */
export async function attestCredentialWorker(
  migrationUrl: string,
  workerUrl: string,
): Promise<void> {
  assertPinnedWorkerEndpoint(migrationUrl, workerUrl);
  const admin = new Client({ connectionString: migrationUrl });
  const worker = new Client({ connectionString: workerUrl, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
    await worker.connect();
    const [trusted] = (
      await admin.query<{ ident: string; db: string }>(
        "SELECT system_identifier::text AS ident, current_database() AS db FROM pg_control_system()",
      )
    ).rows;
    const [session] = (
      await worker.query<{
        ident: string;
        db: string;
        session_user: string;
        current_user: string;
      }>(
        `SELECT system_identifier::text AS ident, current_database() AS db,
                session_user, current_user
         FROM pg_control_system()`,
      )
    ).rows;
    if (
      !trusted ||
      !session ||
      session.session_user !== MANAGED_CREDENTIAL_WORKER ||
      session.current_user !== MANAGED_CREDENTIAL_WORKER ||
      session.ident !== trusted.ident ||
      session.db !== trusted.db
    ) {
      throw new Error("credential worker connection is not the trusted migration database");
    }
  } finally {
    await admin.end().catch(() => undefined);
    await worker.end().catch(() => undefined);
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
    "renew_credential_lease(uuid, uuid)",
    "complete_credential_retirement(uuid, uuid)",
    "redact_dispatch_errors()",
    "purge_redacted_retirements(integer)",
    "register_active_credential(text, text)",
    "record_orphan_credential(text, text, text)",
    "credential_fingerprint(text)",
    "lock_credential_fingerprint(text)",
    "credential_object_is_attachable()",
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

function databaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!name) throw new Error("DATABASE_WORKER_URL must name a database");
  return name;
}

async function legacyQueueCounts(owner: Client): Promise<{
  tombstones: number;
  workItems: number;
  fixtures: number;
  opaqueJobs: number;
  retirementWithoutRegistry: number;
  activeWithoutRegistry: number;
  rawRegistry: number;
}> {
  const tableCount = async (regclass: string) => {
    const exists = await owner.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [
      regclass,
    ]);
    if (!exists.rows[0]?.ok) return 0;
    const rows = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${regclass}`);
    return rows.rows[0]?.n ?? 0;
  };
  const tombstones = await tableCount("queue_private.credential_tombstone");
  const workItems = await tableCount("queue_private.work_item");
  const fixtures = await tableCount("queue_private.legacy_fixture");
  let opaqueJobs = 0;
  const jobs = await owner.query<{ ok: boolean }>(
    "SELECT to_regclass('graphile_worker._private_jobs') IS NOT NULL AS ok",
  );
  const work = await owner.query<{ ok: boolean }>(
    "SELECT to_regclass('queue_private.work_item') IS NOT NULL AS ok",
  );
  if (jobs.rows[0]?.ok && work.rows[0]?.ok) {
    const retirement = await owner.query<{ ok: boolean }>(
      "SELECT to_regclass('queue_private.credential_retirement') IS NOT NULL AS ok",
    );
    const rows = await owner.query<{ n: number }>(
      retirement.rows[0]?.ok
        ? `SELECT count(*)::int AS n
           FROM graphile_worker._private_jobs AS jobs
           WHERE jobs.payload::jsonb ? 'workItemId'
             AND EXISTS (
               SELECT 1 FROM queue_private.work_item AS item
               WHERE item.id::text = jobs.payload::jsonb->>'workItemId'
             )
             AND NOT EXISTS (
               SELECT 1 FROM queue_private.credential_retirement AS retirement
               WHERE retirement.id::text = jobs.payload::jsonb->>'workItemId'
             )`
        : `SELECT count(*)::int AS n
           FROM graphile_worker._private_jobs AS jobs
           WHERE jobs.payload::jsonb ? 'workItemId'
             AND EXISTS (
               SELECT 1 FROM queue_private.work_item AS item
               WHERE item.id::text = jobs.payload::jsonb->>'workItemId'
             )`,
    );
    opaqueJobs = rows.rows[0]?.n ?? 0;
  }
  let retirementWithoutRegistry = 0;
  const retirement = await owner.query<{ ok: boolean }>(
    "SELECT to_regclass('queue_private.credential_retirement') IS NOT NULL AS ok",
  );
  const fingerprint = await owner.query<{ ok: boolean }>(
    "SELECT to_regclass('queue_private.credential_fingerprint') IS NOT NULL AS ok",
  );
  if (retirement.rows[0]?.ok) {
    const rows = await owner.query<{ n: number }>(
      fingerprint.rows[0]?.ok
        ? `SELECT count(*)::int AS n FROM queue_private.credential_retirement AS retirement
           WHERE retirement.state IN ('pending', 'leased')
             AND NOT EXISTS (
               SELECT 1 FROM queue_private.credential_fingerprint AS item
               WHERE item.retirement_id = retirement.id AND item.state = 'retiring'
             )`
        : "SELECT count(*)::int AS n FROM queue_private.credential_retirement",
    );
    retirementWithoutRegistry = rows.rows[0]?.n ?? 0;
  }
  let activeWithoutRegistry = 0;
  const installations = await owner.query<{ ok: boolean }>(
    "SELECT to_regclass('public.messaging_installations') IS NOT NULL AS ok",
  );
  if (installations.rows[0]?.ok) {
    const rows = await owner.query<{ n: number }>(
      fingerprint.rows[0]?.ok
        ? `SELECT count(*)::int AS n FROM messaging_installations AS installation
           WHERE length(installation.ciphertext) > 0
             AND NOT EXISTS (
               SELECT 1 FROM queue_private.credential_fingerprint AS item
               WHERE item.object_id = queue_api.credential_fingerprint(installation.ciphertext)
                 AND item.state = 'active'
                 AND item.installation_id = installation.id
             )`
        : `SELECT count(*)::int AS n FROM messaging_installations
           WHERE length(ciphertext) > 0`,
    );
    activeWithoutRegistry = rows.rows[0]?.n ?? 0;
  }
  const rawRegistry = await tableCount("queue_private.credential_object");
  return {
    tombstones,
    workItems,
    fixtures,
    opaqueJobs,
    retirementWithoutRegistry,
    activeWithoutRegistry,
    rawRegistry,
  };
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

CREATE TABLE IF NOT EXISTS queue_private.credential_fingerprint (
  object_id bytea PRIMARY KEY,
  installation_id text NOT NULL,
  state text NOT NULL,
  generation integer NOT NULL,
  retirement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_fingerprint_state_check CHECK (state IN ('active', 'retiring', 'retired', 'orphan'))
);
ALTER TABLE queue_private.credential_fingerprint OWNER TO ${QUEUE_OWNER};
REVOKE ALL ON TABLE queue_private.credential_fingerprint FROM PUBLIC, rakazo_app;

CREATE TABLE IF NOT EXISTS queue_private.credential_orphan (
  id uuid PRIMARY KEY,
  object_id bytea NOT NULL,
  raw_ref text NOT NULL,
  installation_id text,
  record_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL
);
ALTER TABLE queue_private.credential_orphan OWNER TO ${QUEUE_OWNER};
REVOKE ALL ON TABLE queue_private.credential_orphan FROM PUBLIC, rakazo_app;

CREATE TABLE IF NOT EXISTS queue_private.worker_provenance (
  role_name text PRIMARY KEY,
  role_oid oid NOT NULL
);
ALTER TABLE queue_private.worker_provenance OWNER TO ${QUEUE_OWNER};

CREATE TABLE IF NOT EXISTS queue_private.boundary_version (
  version integer PRIMARY KEY
);
INSERT INTO queue_private.boundary_version (version) VALUES (2) ON CONFLICT DO NOTHING;
ALTER TABLE queue_private.boundary_version OWNER TO ${QUEUE_OWNER};

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
  WHERE id = installation_id;
  IF current_ref IS NULL OR length(current_ref) < 1 THEN
    RAISE EXCEPTION 'installation has no credential' USING ERRCODE = '22023';
  END IF;
  PERFORM queue_api.lock_credential_fingerprint(current_ref);
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
  PERFORM queue_api.lock_credential_fingerprint(stored);
  INSERT INTO queue_private.credential_fingerprint
    (object_id, installation_id, state, generation, retirement_id)
  VALUES (queue_api.credential_fingerprint(stored), installation, 'retiring', 1, item_id)
  ON CONFLICT (object_id) DO UPDATE
    SET state = 'retiring', retirement_id = EXCLUDED.retirement_id
    WHERE queue_private.credential_fingerprint.state = 'active'
      AND queue_private.credential_fingerprint.installation_id = EXCLUDED.installation_id;
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

DROP FUNCTION IF EXISTS queue_api.claim_credential_retirement(uuid);
CREATE OR REPLACE FUNCTION queue_api.claim_credential_retirement(item_id uuid)
RETURNS TABLE (status text, installation_id text, retired_ref text, fence uuid)
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
  IF inst IS NULL THEN
    status := 'missing';
    RETURN NEXT;
    RETURN;
  END IF;
  IF stored IS NULL OR current_state IN ('deleted', 'skipped_current') THEN
    status := 'terminal';
    RETURN NEXT;
    RETURN;
  END IF;
  IF current_state = 'leased' AND held_until IS NOT NULL AND held_until > clock_timestamp() THEN
    status := 'busy';
    RETURN NEXT;
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
    status := 'terminal';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM 1 FROM queue_private.credential_fingerprint
  WHERE object_id = queue_api.credential_fingerprint(stored) AND state = 'retiring';
  IF NOT FOUND THEN
    status := 'missing';
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE queue_private.credential_retirement
  SET state = 'leased', lease_fence = next_fence,
      leased_until = clock_timestamp() + make_interval(secs => ${CREDENTIAL_RETIREMENT_LEASE_SECONDS})
  WHERE id = item_id;
  status := 'ready';
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
  WHERE id = item_id AND state = 'leased' AND lease_fence = fence
    AND leased_until > clock_timestamp();
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated = 1 THEN
    UPDATE queue_private.credential_fingerprint
    SET state = 'retired'
    WHERE retirement_id = item_id AND state = 'retiring';
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

CREATE OR REPLACE FUNCTION queue_api.renew_credential_lease(item_id uuid, fence uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  updated integer;
BEGIN
  UPDATE queue_private.credential_retirement
  SET leased_until = clock_timestamp() + make_interval(secs => ${CREDENTIAL_RETIREMENT_LEASE_SECONDS})
  WHERE id = item_id AND state = 'leased' AND lease_fence = fence
    AND leased_until > clock_timestamp();
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
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

DROP FUNCTION IF EXISTS queue_api.purge_dummy_orphans();

DROP FUNCTION IF EXISTS queue_api.register_active_credential(text);
CREATE OR REPLACE FUNCTION queue_api.credential_fingerprint(p_object_key text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
  SELECT sha256(convert_to('rakazo-credential-object-v1:' || p_object_key, 'UTF8'));
$fn$;

CREATE OR REPLACE FUNCTION queue_api.lock_credential_fingerprint(p_object_key text)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  fp bytea := queue_api.credential_fingerprint(p_object_key);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(encode(fp, 'hex'), 0));
  RETURN fp;
END
$fn$;

DROP FUNCTION IF EXISTS queue_api.register_active_credential(text);
DROP FUNCTION IF EXISTS queue_api.register_active_credential(text, text);
CREATE OR REPLACE FUNCTION queue_api.register_active_credential(p_installation_id text, p_object_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  fp bytea;
  current_state text;
  bound_installation text;
BEGIN
  IF p_installation_id IS NULL OR length(p_installation_id) < 1
     OR p_object_key IS NULL OR length(p_object_key) < 1 OR length(p_object_key) > 2000 THEN
    RAISE EXCEPTION 'invalid credential object' USING ERRCODE = '22023';
  END IF;
  fp := queue_api.lock_credential_fingerprint(p_object_key);
  INSERT INTO queue_private.credential_fingerprint
    (object_id, installation_id, state, generation)
  VALUES (fp, p_installation_id, 'active', 1)
  ON CONFLICT (object_id) DO NOTHING;
  SELECT state, installation_id INTO current_state, bound_installation
  FROM queue_private.credential_fingerprint
  WHERE object_id = fp
  FOR UPDATE;
  IF current_state IS DISTINCT FROM 'active' OR bound_installation IS DISTINCT FROM p_installation_id THEN
    RAISE EXCEPTION 'credential object cannot be reused' USING ERRCODE = '23514';
  END IF;
  RETURN 1;
END
$fn$;

DROP FUNCTION IF EXISTS queue_api.record_orphan_credential(text);
CREATE OR REPLACE FUNCTION queue_api.record_orphan_credential(
  p_object_key text,
  p_installation_id text,
  p_record_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  fp bytea;
  current_state text;
BEGIN
  IF p_object_key IS NULL OR length(p_object_key) < 1 OR length(p_object_key) > 2000 THEN
    RAISE EXCEPTION 'invalid credential object' USING ERRCODE = '22023';
  END IF;
  fp := queue_api.lock_credential_fingerprint(p_object_key);
  INSERT INTO queue_private.credential_fingerprint
    (object_id, installation_id, state, generation)
  VALUES (fp, coalesce(p_installation_id, ''), 'orphan', 1)
  ON CONFLICT (object_id) DO NOTHING;
  SELECT state INTO current_state
  FROM queue_private.credential_fingerprint
  WHERE object_id = fp
  FOR UPDATE;
  IF current_state = 'active' THEN
    RAISE EXCEPTION 'credential object is active' USING ERRCODE = '23514';
  END IF;
  INSERT INTO queue_private.credential_orphan
    (id, object_id, raw_ref, installation_id, record_id, retain_until)
  VALUES (
    gen_random_uuid(), fp, p_object_key, p_installation_id, p_record_id,
    clock_timestamp() + interval '1 hour'
  );
  RETURN 1;
END
$fn$;

CREATE OR REPLACE FUNCTION queue_api.credential_object_is_attachable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  fp bytea;
  current_state text;
  bound_installation text;
BEGIN
  IF NEW.ciphertext IS NULL OR length(NEW.ciphertext) = 0 THEN
    RETURN NEW;
  END IF;
  fp := queue_api.lock_credential_fingerprint(NEW.ciphertext);
  SELECT state, installation_id INTO current_state, bound_installation
  FROM queue_private.credential_fingerprint
  WHERE object_id = fp
  FOR UPDATE;
  IF current_state IS DISTINCT FROM 'active' OR bound_installation IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'credential object is not an active generation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS credential_object_is_attachable ON public.messaging_installations;
CREATE TRIGGER credential_object_is_attachable
  BEFORE INSERT OR UPDATE OF ciphertext ON public.messaging_installations
  FOR EACH ROW EXECUTE FUNCTION queue_api.credential_object_is_attachable();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA queue_api FROM PUBLIC;
GRANT USAGE ON SCHEMA queue_api TO rakazo_app;
GRANT EXECUTE ON FUNCTION
  queue_api.capture_current_credential(text),
  queue_api.enqueue_captured_credential(uuid),
  queue_api.register_active_credential(text, text),
  queue_api.record_orphan_credential(text, text, text)
TO rakazo_app;
`;

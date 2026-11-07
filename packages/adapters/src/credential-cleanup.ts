// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { CREDENTIAL_DELETE_TIMEOUT_MS } from "@rakazo/db";
import type { Pool } from "pg";

type RetirementClient = Pick<PrismaClient, "$queryRaw">;

/** Registers a new physical object. A retiring, retired, or orphan object is refused. */
export async function registerActiveCredential(
  tx: RetirementClient,
  objectKey: string,
): Promise<void> {
  await tx.$queryRaw`SELECT queue_api.register_active_credential(${objectKey}::text)`;
}

/** Records an object that was created and never committed. Does not delete it. */
export async function recordOrphanCredential(
  tx: RetirementClient,
  objectKey: string,
): Promise<void> {
  await tx.$queryRaw`SELECT queue_api.record_orphan_credential(${objectKey}::text)`;
}

/** Copies the installation's current reference and returns the retirement id. */
export async function captureCredentialRetirement(
  tx: RetirementClient,
  installationId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT queue_api.capture_current_credential(${installationId}::text) AS id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error("credential retirement was not captured");
  return id;
}

/** Enqueues the captured retirement after the installation no longer stores that reference. */
export async function enqueueCredentialRetirement(
  tx: RetirementClient,
  workItemId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT queue_api.enqueue_captured_credential(${workItemId}::uuid)`;
}

/**
 * Claims one retirement, deletes the retired reference, and completes it.
 * The current reference is read inside the claim. An absent secret is success.
 * Any other failure leaves the lease to expire and throws a stable code.
 */
export async function performCredentialCleanup(
  deps: { pool: Pool; secretStore: Pick<SecretStore, "delete"> },
  workItemId: string,
): Promise<void> {
  const claimed = await deps.pool.query<{
    installation_id: string;
    retired_ref: string;
    fence: string;
  }>(
    "SELECT installation_id, retired_ref, fence FROM queue_api.claim_credential_retirement($1::uuid)",
    [workItemId],
  );
  const retirement = claimed.rows[0];
  if (!retirement) return;
  const renewed = await deps.pool.query<{ ok: number }>(
    "SELECT queue_api.renew_credential_lease($1::uuid, $2::uuid) AS ok",
    [workItemId, retirement.fence],
  );
  if (renewed.rows[0]?.ok !== 1) return;
  try {
    try {
      await deps.secretStore.delete(retirement.retired_ref, {
        recordId: retirement.installation_id,
        signal: AbortSignal.timeout(CREDENTIAL_DELETE_TIMEOUT_MS),
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "not_found") throw new Error("credential_cleanup_failed");
    }
    await deps.pool.query("SELECT queue_api.complete_credential_retirement($1::uuid, $2::uuid)", [
      workItemId,
      retirement.fence,
    ]);
    await deps.pool.query("SELECT queue_api.redact_dispatch_errors()");
  } catch (error) {
    if (error instanceof Error && error.message === "credential_cleanup_failed") throw error;
    throw new Error("credential_cleanup_failed");
  }
}

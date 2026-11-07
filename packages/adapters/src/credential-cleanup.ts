// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { Pool } from "pg";

/**
 * Loads one protected tombstone and deletes the retired reference only when it
 * is not the installation's current ciphertext. The queue payload is the work
 * item id. Failures throw a stable code so Graphile does not store the reference.
 */
export async function performCredentialCleanup(
  deps: {
    pool: Pool;
    prisma: Pick<PrismaClient, "messagingInstallation">;
    secretStore: SecretStore;
  },
  workItemId: string,
): Promise<void> {
  const located = await deps.pool.query<{ credential_installation: string | null }>(
    "SELECT queue_api.credential_installation($1::uuid) AS credential_installation",
    [workItemId],
  );
  const installationId = located.rows[0]?.credential_installation;
  if (!installationId) return;
  const installation = await deps.prisma.messagingInstallation.findUnique({
    where: { id: installationId },
    select: { ciphertext: true },
  });
  const claimed = await deps.pool.query<{ installation_id: string; retired_ref: string }>(
    "SELECT installation_id, retired_ref FROM queue_api.claim_retired_credential($1::uuid, $2::text)",
    [workItemId, installation?.ciphertext ?? null],
  );
  const retired = claimed.rows[0];
  if (!retired) return;
  try {
    await deps.secretStore.delete(retired.retired_ref, {
      recordId: retired.installation_id,
      signal: AbortSignal.timeout(10_000),
    });
    await deps.pool.query("SELECT queue_api.complete_credential_cleanup($1::uuid)", [workItemId]);
  } catch {
    throw new Error("credential_cleanup_failed");
  }
}

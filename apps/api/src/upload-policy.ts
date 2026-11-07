// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import type { Actor, UploadPolicy } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import {
  AttachmentValidationError,
  boundedUploadCeiling,
  effectiveUploadPolicy,
  proposeUploadPolicyChange,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import { orpcAttachmentError } from "./attachment-error.js";

type PolicyDeps = {
  prisma: PrismaClient;
  env: PolicyEnv;
};

type PolicyEnv = {
  maxUploadSizeBytes?: number;
  uploadSizeExplicit?: boolean;
  adminEmails?: string[];
};

export function uploadPolicyFor(
  env: PolicyEnv,
  persistedBytes: number | null | undefined,
): UploadPolicy {
  return effectiveUploadPolicy({
    ceilingBytes: boundedUploadCeiling(env.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES),
    envExplicit: env.uploadSizeExplicit === true,
    persistedBytes,
  });
}

export async function currentUploadPolicy(deps: PolicyDeps): Promise<UploadPolicy> {
  const find = deps.prisma.deploymentSettings?.findUnique;
  if (typeof find !== "function") return uploadPolicyFor(deps.env, null);
  const row = await deps.prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { maxUploadSizeBytes: true },
  });
  return uploadPolicyFor(deps.env, row?.maxUploadSizeBytes);
}

export async function setUploadPolicy(
  deps: PolicyDeps,
  actor: Actor,
  maxFileBytes: number,
): Promise<UploadPolicy> {
  await requireAdmin(
    { prisma: deps.prisma, env: { adminEmails: deps.env.adminEmails ?? [] } },
    actor.userId,
  );
  let next: { maxFileBytes: number };
  try {
    next = proposeUploadPolicyChange({
      envExplicit: deps.env.uploadSizeExplicit === true,
      ceilingBytes: uploadPolicyFor(deps.env, null).ceilingBytes,
      maxFileBytes,
    });
  } catch (error) {
    if (error instanceof AttachmentValidationError) throw orpcAttachmentError(error);
    throw error;
  }
  const committed = await runAsSystem("commit the upload policy and its audit event", () =>
    deps.prisma.$transaction(async (tx) => {
      await tx.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: {},
      });
      const locked = await tx.$queryRaw<Array<{ maxUploadSizeBytes: number | null }>>`
        SELECT "maxUploadSizeBytes" FROM "deployment_settings" WHERE id = 'default' FOR UPDATE
      `;
      const previous = locked[0]?.maxUploadSizeBytes ?? null;
      if (previous === next.maxFileBytes) return { changed: false as const, previous };
      const space = await tx.space.findUnique({
        where: { id: actor.spaceId },
        select: { organizationId: true, name: true },
      });
      if (!space) throw new Error("upload policy actor has no space");
      await tx.deploymentSettings.update({
        where: { id: "default" },
        data: { maxUploadSizeBytes: next.maxFileBytes },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: space.organizationId,
          spaceId: actor.spaceId,
          spaceName: space.name,
          actorType: "user",
          actorId: actor.userId,
          action: "upload.policy.changed",
          targetType: "deployment",
          targetId: "default",
          outcome: "success",
          metadata: { previousBytes: previous, maxFileBytes: next.maxFileBytes },
        },
      });
      return { changed: true as const, previous };
    }),
  );
  return uploadPolicyFor(deps.env, committed.changed ? next.maxFileBytes : committed.previous);
}

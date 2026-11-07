// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { ORPCError } from "@orpc/server";
import type { Actor, UploadPolicy } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, UPLOAD_POLICY_FORBIDDEN_CODE } from "@rakazo/contracts";
import {
  AttachmentValidationError,
  boundedUploadCeiling,
  effectiveUploadPolicy,
  proposeUploadPolicyChange,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recordAuditEvent, runAsSystem } from "@rakazo/db";
import { orpcAttachmentError } from "./attachment-error.js";

type PolicyDeps = {
  prisma: Pick<PrismaClient, "deploymentSettings" | "member">;
  env: PolicyEnv;
};

type PolicyEnv = {
  maxUploadSizeBytes?: number;
  uploadSizeExplicit?: boolean;
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
  const member = await deps.prisma.member.findFirst({
    where: {
      userId: actor.userId,
      organization: { spaces: { some: { id: actor.spaceId } } },
    },
    select: { role: true },
  });
  let next: { maxFileBytes: number };
  try {
    next = proposeUploadPolicyChange({
      role: member?.role,
      envExplicit: deps.env.uploadSizeExplicit === true,
      ceilingBytes: uploadPolicyFor(deps.env, null).ceilingBytes,
      maxFileBytes,
    });
  } catch (error) {
    if (error instanceof AttachmentValidationError && error.code === UPLOAD_POLICY_FORBIDDEN_CODE) {
      throw new ORPCError("FORBIDDEN", { message: error.message, data: { code: error.code } });
    }
    if (error instanceof AttachmentValidationError) throw orpcAttachmentError(error);
    throw error;
  }
  const current = await deps.prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { maxUploadSizeBytes: true },
  });
  if (current?.maxUploadSizeBytes !== next.maxFileBytes) {
    await runAsSystem("persist the upload policy", () =>
      deps.prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { maxUploadSizeBytes: next.maxFileBytes },
      }),
    );
    await recordAuditEvent({
      action: "upload.policy.changed",
      actor: { type: "user", id: actor.userId },
      spaceId: actor.spaceId,
      target: { type: "deployment", id: "default" },
      metadata: { maxFileBytes: next.maxFileBytes },
    });
  }
  return uploadPolicyFor(deps.env, next.maxFileBytes);
}

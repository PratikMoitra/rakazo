// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// These calls use Hono app.request. They are in-process application requests, not a listening socket.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailEmulator, LocalArtifactStore } from "@rakazo/adapters";
import { DEFAULT_UPLOAD_MAX_BYTES } from "@rakazo/contracts";
import { asSystem } from "@rakazo/db";
import { expect, it } from "vitest";
import { requeueRunAfterShutdown } from "../../../packages/adapters/src/run-lifecycle.js";
import { attachWorkspaceFileToThread } from "../../../packages/adapters/src/thread-artifacts.js";
import { createApp } from "./app.js";
import { rpcRequestMaxBytes } from "./request-body-limit.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";
const limit = DEFAULT_UPLOAD_MAX_BYTES;

it.skipIf(!databaseUrl)(
  "enforces the upload policy, chat recovery, and welcome mail on a disposable database",
  async () => {
    process.env.BETTER_AUTH_SECRET ??= "phase1-auth-secret-phase1-auth-secret";
    process.env.ENCRYPTION_KEY ??= "phase1-encryption-key-phase1-encryption";
    process.env.SCREEN_PROXY_SECRET ??= "phase1-screen-proxy-secret-32chars";
    process.env.SANDBOX_SUPERVISOR_TOKEN ??= "phase1-supervisor-token-32chars-xx";
    delete process.env.MAX_UPLOAD_SIZE_MB;
    const adminEmail = `phase1-deploy-admin-${Date.now()}@example.test`;
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-phase1-"));
    const email = new EmailEmulator();
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: origin,
      authUrl: origin,
      welcomeEmailEnabled: true,
      email,
      uploadSizeExplicit: false,
      maxUploadSizeBytes: limit,
      adminEmails: [adminEmail],
    });
    const system = asSystem(handles.prisma);
    const call = (cookie: string, procedure: string, json: unknown = {}) =>
      handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ json }),
      });
    const jsonOf = async (response: Response) => (await response.json()) as { json: unknown };
    try {
      const ownerAddress = `phase1-owner-${Date.now()}@example.test`;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: ownerAddress,
          password: "test-password-123",
          name: "Phase Owner",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie =
        signup.headers
          .getSetCookie?.()
          .map((value) => value.split(";")[0])
          .join("; ") ??
        signup.headers.get("set-cookie")?.split(";")[0] ??
        "";
      expect(cookie).toContain("=");
      await viWait(async () => email.sent.some((message) => message.to === ownerAddress));

      const me = (await jsonOf(await call(cookie, "me"))) as {
        json: {
          maxUploadSizeBytes: number;
          uploadPolicy: { source: string; maxFileBytes: number };
        };
      };
      expect(me.json.maxUploadSizeBytes).toBe(limit);
      expect(me.json.uploadPolicy).toMatchObject({
        source: "default",
        maxFileBytes: limit,
        envLocked: false,
      });

      const bot = (await jsonOf(
        await call(cookie, "bots/create", {
          name: "Phase bot",
          title: "",
          description: "",
          instructions: "Reply briefly.",
          notifyOnFinish: false,
        }),
      )) as { json: { id: string } };
      const botId = bot.json.id;
      const before = await system.artifact.count();
      const chunked = await handles.app.request(
        new Request(`http://127.0.0.1/rpc/artifacts/create`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    json: {
                      botId,
                      name: "chunk.txt",
                      mimeType: "text/plain",
                      contentBase64: Buffer.from("hello").toString("base64"),
                    },
                  }),
                ),
              );
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      );
      expect(chunked.status).toBe(200);
      const chunkedId = ((await chunked.json()) as { json: { id: string } }).json.id;
      const unfinished = await handles.app.request(
        new Request("http://127.0.0.1/rpc/artifacts/create", {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: new ReadableStream({
            pull(controller) {
              controller.error(new Error("client cancelled"));
            },
          }),
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      );
      expect(unfinished.status).toBe(400);
      expect(await unfinished.json()).toMatchObject({ code: "upload_incomplete" });
      expect(await system.artifact.count()).toBe(before + 1);

      for (const size of [limit - 1, limit]) {
        const response = await call(cookie, "artifacts/create", {
          botId,
          name: `${size}.txt`,
          mimeType: "text/plain",
          contentBase64: Buffer.alloc(size, 1).toString("base64"),
        });
        expect(response.status, `size ${size}`).toBe(200);
      }
      const over = await call(cookie, "artifacts/create", {
        botId,
        name: "over.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.alloc(limit + 1, 1).toString("base64"),
      });
      expect(over.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await over.json())).toContain("upload_too_large");
      const names = await system.artifact.findMany({ select: { name: true } });
      expect(names.some((row) => row.name === "over.txt")).toBe(false);

      const cap = rpcRequestMaxBytes(limit);
      const lying = await handles.app.request(
        new Request("http://127.0.0.1/rpc/artifacts/create", {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json", "content-length": "2" },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.alloc(cap + 1, 0x61));
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      );
      expect(lying.status).toBe(413);
      expect(await lying.json()).toMatchObject({ code: "upload_too_large" });

      const otherSignup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `phase1-other-${Date.now()}@example.test`,
          password: "test-password-123",
          name: "Other",
        }),
      });
      const otherCookie =
        otherSignup.headers
          .getSetCookie?.()
          .map((value) => value.split(";")[0])
          .join("; ") ?? "";
      expect(otherSignup.status).toBeLessThan(400);
      expect(otherCookie).toContain("=");
      const denied = await call(otherCookie, "artifacts/get", {
        botId,
        artifactId: chunkedId,
      });
      expect(denied.status).toBeGreaterThanOrEqual(400);

      const sent = await call(cookie, "threads/send", { botId, text: "hello from phase one" });
      expect(sent.status).toBe(200);
      const sentBody = (await sent.json()) as { json: { runId: string } };
      let chatState = "";
      await viWait(async () => {
        const row = await system.run.findUnique({
          where: { id: sentBody.json.runId },
          select: { status: true, error: true },
        });
        chatState = JSON.stringify(row);
        return row?.status === "completed" || row?.status === "failed";
      }).catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${chatState}`);
      });
      const run = await system.run.findUnique({ where: { id: sentBody.json.runId } });
      expect(run?.status).toBe("completed");
      await system.run.update({
        where: { id: run!.id },
        data: {
          status: "running",
          leaseOwner: "worker-a",
          leaseFence: 3,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const released = await requeueRunAfterShutdown(
        { prisma: system, jobs: { enqueue: async () => undefined } } as never,
        run!.id,
        "worker-a",
        3,
      );
      expect(released).toBe(true);
      expect(await system.run.findUnique({ where: { id: run!.id } })).toMatchObject({
        status: "queued",
        leaseOwner: null,
      });
      expect(
        await requeueRunAfterShutdown(
          { prisma: system, jobs: { enqueue: async () => undefined } } as never,
          run!.id,
          "worker-a",
          3,
        ),
      ).toBe(false);

      const ownerDenied = await call(cookie, "uploadPolicy/set", { maxFileBytes: 1024 * 1024 });
      expect(ownerDenied.status).toBe(403);
      const otherDenied = await call(otherCookie, "uploadPolicy/set", {
        maxFileBytes: 1024 * 1024,
      });
      expect(otherDenied.status).toBe(403);
      const adminSignup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: adminEmail,
          password: "test-password-123",
          name: "Deploy Admin",
        }),
      });
      expect(adminSignup.status).toBeLessThan(400);
      const adminCookie =
        adminSignup.headers
          .getSetCookie?.()
          .map((value) => value.split(";")[0])
          .join("; ") ?? "";
      await system.user.update({ where: { email: adminEmail }, data: { emailVerified: false } });
      const unverified = await call(adminCookie, "uploadPolicy/set", { maxFileBytes: 1024 * 1024 });
      expect(unverified.status).toBe(403);
      await system.user.update({ where: { email: adminEmail }, data: { emailVerified: true } });
      const changed = await call(adminCookie, "uploadPolicy/set", { maxFileBytes: 1024 * 1024 });
      expect(changed.status).toBe(200);
      expect(
        ((await changed.json()) as { json: { source: string; maxFileBytes: number } }).json,
      ).toMatchObject({
        source: "persisted",
        maxFileBytes: 1024 * 1024,
      });
      const ownerId = ((await jsonOf(await call(cookie, "me"))) as { json: { userId: string } })
        .json.userId;
      const adminId = (
        (await jsonOf(await call(adminCookie, "me"))) as { json: { userId: string } }
      ).json.userId;
      const audits = async () =>
        system.auditEvent.count({
          where: { action: "upload.policy.changed", actorId: adminId },
        });
      expect(await audits()).toBe(1);
      const [sameA, sameB] = await Promise.all([
        call(adminCookie, "uploadPolicy/set", { maxFileBytes: 1024 * 1024 }),
        call(adminCookie, "uploadPolicy/set", { maxFileBytes: 1024 * 1024 }),
      ]);
      expect([sameA.status, sameB.status].sort()).toEqual([200, 200]);
      expect(await audits()).toBe(1);
      await Promise.all([
        call(adminCookie, "uploadPolicy/set", { maxFileBytes: 1024 * 1024 }),
        call(adminCookie, "uploadPolicy/set", { maxFileBytes: 2 * 1024 * 1024 }),
      ]);
      const afterConflict = await audits();
      expect(afterConflict).toBeGreaterThanOrEqual(2);
      expect(afterConflict).toBeLessThanOrEqual(3);
      const finalPolicy = (
        (await jsonOf(await call(adminCookie, "uploadPolicy/get"))) as {
          json: { maxFileBytes: number };
        }
      ).json.maxFileBytes;
      const ordered = await system.auditEvent.findMany({
        where: { action: "upload.policy.changed", actorId: adminId },
        orderBy: { createdAt: "asc" },
        select: { metadata: true },
      });
      const lastBytes = (ordered.at(-1)?.metadata as { maxFileBytes?: number } | null)
        ?.maxFileBytes;
      expect(finalPolicy).toBe(lastBytes);
      const botRow = await system.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { spaceId: true },
      });
      const generated = new LocalArtifactStore(dataDir);
      const beforeGenerated = await system.artifact.count();
      await expect(
        attachWorkspaceFileToThread(
          {
            prisma: system,
            artifacts: generated,
            maxUploadSizeBytes: limit,
            uploadSizeExplicit: false,
          },
          {
            spaceId: botRow.spaceId,
            userId: ownerId,
            botId,
            runId: run!.id,
            filePath: "notes/too-big.txt",
            bytes: Buffer.alloc(3 * 1024 * 1024, 3),
            operationId: "phase1-generated",
          },
        ),
      ).rejects.toMatchObject({ code: "upload_too_large" });
      expect(await system.artifact.count()).toBe(beforeGenerated);
      const beforeFailure = await system.deploymentSettings.findUniqueOrThrow({
        where: { id: "default" },
        select: { maxUploadSizeBytes: true },
      });
      await system.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION phase1_fail_upload_audit() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.action = 'upload.policy.changed' THEN
            RAISE EXCEPTION 'phase1 audit failure';
          END IF;
          RETURN NEW;
        END
        $fn$
      `);
      await system.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS phase1_fail_upload_audit ON audit_events`,
      );
      await system.$executeRawUnsafe(`
        CREATE TRIGGER phase1_fail_upload_audit
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION phase1_fail_upload_audit()
      `);
      const failedAudit = await call(adminCookie, "uploadPolicy/set", {
        maxFileBytes:
          beforeFailure.maxUploadSizeBytes === 1024 * 1024 ? 2 * 1024 * 1024 : 1024 * 1024,
      });
      expect(failedAudit.status).toBeGreaterThanOrEqual(500);
      expect(
        (
          await system.deploymentSettings.findUniqueOrThrow({
            where: { id: "default" },
            select: { maxUploadSizeBytes: true },
          })
        ).maxUploadSizeBytes,
      ).toBe(beforeFailure.maxUploadSizeBytes);
      expect(await audits()).toBe(afterConflict);
      await system.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS phase1_fail_upload_audit ON audit_events; DROP FUNCTION IF EXISTS phase1_fail_upload_audit();`,
      );
      const smallOver = await call(cookie, "artifacts/create", {
        botId,
        name: "small-over.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.alloc(2 * 1024 * 1024 + 1, 2).toString("base64"),
      });
      expect(JSON.stringify(await smallOver.json())).toContain("upload_too_large");

      const locked = await createApp({
        databaseUrl: databaseUrl!,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        webOrigin: origin,
        authUrl: origin,
        uploadSizeExplicit: true,
        maxUploadSizeBytes: 10 * 1024 * 1024,
        adminEmails: [adminEmail],
      });
      try {
        const lockedMe = (await jsonOf(
          await locked.app.request("/rpc/me", {
            method: "POST",
            headers: { "content-type": "application/json", cookie, origin },
            body: JSON.stringify({ json: {} }),
          }),
        )) as { json: { uploadPolicy: { source: string; maxFileBytes: number } } };
        expect(lockedMe.json.uploadPolicy).toMatchObject({
          source: "env",
          envLocked: true,
          maxFileBytes: 10 * 1024 * 1024,
        });
        const refused = await locked.app.request("/rpc/uploadPolicy/set", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: adminCookie, origin },
          body: JSON.stringify({ json: { maxFileBytes: 1024 * 1024 } }),
        });
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(await refused.json())).toContain("upload_policy_locked");
        expect(await audits()).toBe(afterConflict);
      } finally {
        await locked.stop();
      }
    } finally {
      await system.deploymentSettings
        .update({
          where: { id: "default" },
          data: { maxUploadSizeBytes: null },
        })
        .catch(() => undefined);
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  180_000,
);

async function viWait(predicate: () => Promise<boolean>, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the disposable app");
}

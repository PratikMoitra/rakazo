// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asSystem,
  describeRowSecurity,
  provisionRuntimeRole,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { expect, it } from "vitest";
import { createApp } from "./app.js";

const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(migrationUrl);

it.skipIf(!enabled)(
  "enforces cross-space artifact denial as a non-owner runtime role",
  async () => {
    const runtimeUrl = new URL(migrationUrl!);
    runtimeUrl.username = "rakazo_phase1_runtime";
    runtimeUrl.password = "phase1-runtime-password";
    await provisionRuntimeRole(migrationUrl!, runtimeUrl.toString());
    process.env.BETTER_AUTH_SECRET ??= "phase1-auth-secret-phase1-auth-secret";
    process.env.ENCRYPTION_KEY ??= "phase1-encryption-key-phase1-encryption";
    process.env.SCREEN_PROXY_SECRET ??= "phase1-screen-proxy-secret-32chars";
    process.env.SANDBOX_SUPERVISOR_TOKEN ??= "phase1-supervisor-token-32chars-xx";
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-phase1-rls-"));
    const origin = "http://127.0.0.1:5173";
    const handles = await createApp({
      databaseUrl: runtimeUrl.toString(),
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: origin,
      authUrl: origin,
      uploadSizeExplicit: false,
      maxUploadSizeBytes: 26_214_400,
    });
    const call = (cookie: string, procedure: string, json: unknown = {}) =>
      handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ json }),
      });
    const cookieOf = (response: Response) =>
      response.headers
        .getSetCookie?.()
        .map((value) => value.split(";")[0])
        .join("; ") ?? "";
    try {
      const status = await describeRowSecurity(handles.prisma);
      expect(status).toMatchObject({ enforced: true, role: "rakazo_phase1_runtime" });
      const role = await handles.prisma.$queryRawUnsafe<
        Array<{ rolsuper: boolean; rolbypassrls: boolean }>
      >(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
      expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const protectedTables = await handles.prisma.$queryRawUnsafe<
        Array<{ relname: string; relrowsecurity: boolean }>
      >(
        `SELECT c.relname, c.relrowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname IN ('artifacts', 'messages')`,
      );
      expect(protectedTables).toEqual(
        expect.arrayContaining([
          { relname: "artifacts", relrowsecurity: true },
          { relname: "messages", relrowsecurity: true },
        ]),
      );
      const queue = await runAsSystem("phase1 job-table probe", () =>
        handles.prisma.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean }>>(
          `SELECT c.relname, c.relrowsecurity
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'graphile_worker' AND c.relname = '_private_jobs'`,
        ),
      );
      expect(queue).toEqual([{ relname: "_private_jobs", relrowsecurity: true }]);

      const signup = async (name: string) => {
        const response = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            email: `${name}-${Date.now()}@example.test`,
            password: "test-password-123",
            name,
          }),
        });
        expect(response.status).toBeLessThan(400);
        return cookieOf(response);
      };
      const owner = await signup("rls-owner");
      const other = await signup("rls-other");
      expect(owner).toContain("=");
      expect(other).toContain("=");
      const bot = (await (
        await call(owner, "bots/create", {
          name: "RLS bot",
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        })
      ).json()) as { json: { id: string } };
      const uploaded = (await (
        await call(owner, "artifacts/create", {
          botId: bot.json.id,
          name: "secret.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from("secret").toString("base64"),
        })
      ).json()) as { json: { id: string } };
      const denied = await call(other, "artifacts/get", {
        botId: bot.json.id,
        artifactId: uploaded.json.id,
      });
      expect(denied.status).toBeGreaterThanOrEqual(400);

      const artifact = await asSystem(handles.prisma).artifact.findUniqueOrThrow({
        where: { id: uploaded.json.id },
        select: { id: true, spaceId: true, userId: true },
      });
      const visible = await runAsTenant(
        { spaceId: artifact.spaceId, userId: artifact.userId },
        () => handles.prisma.artifact.findMany({ select: { id: true } }),
      );
      expect(visible.map((row) => row.id)).toContain(artifact.id);
      const foreign = await asSystem(handles.prisma).spaceMember.findFirstOrThrow({
        where: { spaceId: { not: artifact.spaceId } },
        select: { spaceId: true, userId: true },
      });
      const hidden = await runAsTenant({ spaceId: foreign.spaceId, userId: foreign.userId }, () =>
        handles.prisma.artifact.findMany({ where: { id: artifact.id }, select: { id: true } }),
      );
      expect(hidden).toEqual([]);
      const queued = await runAsSystem("phase1 queue probe", () =>
        handles.prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
          `SELECT current_setting('row_security', true) = 'on' AS ok`,
        ),
      );
      expect(queued[0]?.ok).toBe(true);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  120_000,
);

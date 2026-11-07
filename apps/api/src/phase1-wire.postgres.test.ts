// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// These requests use a local listening socket. They are not the in-process Hono app.request calls.
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { asSystem } from "@rakazo/db";
import { expect, it } from "vitest";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";

it.skipIf(!databaseUrl)(
  "rejects chunked, disconnected, and badly framed uploads on a local listener",
  async () => {
    process.env.BETTER_AUTH_SECRET ??= "phase1-auth-secret-phase1-auth-secret";
    process.env.ENCRYPTION_KEY ??= "phase1-encryption-key-phase1-encryption";
    process.env.SCREEN_PROXY_SECRET ??= "phase1-screen-proxy-secret-32chars";
    process.env.SANDBOX_SUPERVISOR_TOKEN ??= "phase1-supervisor-token-32chars-xx";
    delete process.env.MAX_UPLOAD_SIZE_MB;
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-phase1-wire-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
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
    let appCalls = 0;
    const parserCodes: string[] = [];
    let partialAck: (() => void) | undefined;
    const partialReceived = new Promise<void>((resolve) => {
      partialAck = resolve;
    });
    let partialForward: Promise<void> = Promise.resolve();
    const server = http.createServer((request, response) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let started = false;
      let failed = false;
      const seen: Buffer[] = [];
      const start = () => {
        if (started || failed) return;
        started = true;
        if (request.url?.startsWith("/rpc/artifacts/create")) appCalls += 1;
        const stream = new ReadableStream<Uint8Array>({
          start(control) {
            controller = control;
          },
        });
        const forward = forwardStream(handles.app.fetch, request, stream, response);
        if (request.url?.includes("artifacts/create")) partialForward = forward;
      };
      request.on("data", (chunk: Buffer) => {
        seen.push(chunk);
        if (!started) start();
        controller?.enqueue(new Uint8Array(chunk));
        const prefix = Buffer.concat(seen).subarray(0, 400).toString("utf8");
        if (prefix.includes('"name":"partial.txt"') && prefix.includes('"contentBase64":"')) {
          partialAck?.();
        }
      });
      request.on("end", () => {
        if (!started) start();
        controller?.close();
      });
      request.on("aborted", () => {
        failed = true;
        controller?.error(new Error("upload_aborted"));
      });
    });
    server.on("clientError", (error, socket) => {
      const code = "code" in error && typeof error.code === "string" ? error.code : "";
      if (code) parserCodes.push(code);
      if (socket.writable) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      } else socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const system = asSystem(handles.prisma);
    try {
      const signup = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `phase1-wire-${Date.now()}@example.test`,
          password: "test-password-123",
          name: "Wire",
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
      const bot = (await (
        await fetch(`http://127.0.0.1:${port}/rpc/bots/create`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: JSON.stringify({
            json: {
              name: "Wire bot",
              title: "",
              description: "",
              instructions: "",
              notifyOnFinish: false,
            },
          }),
        })
      ).json()) as { json: { id: string } };
      const owned = () => system.artifact.count({ where: { botId: bot.json.id } });
      const before = await owned();
      const under = await chunkedUpload(port, cookie, bot.json.id, 26_214_399, "under.txt");
      expect(under.status).toBe(200);
      const accepted = await chunkedUpload(port, cookie, bot.json.id, 26_214_400, "at.txt");
      expect(accepted.status).toBe(200);
      const rejected = await chunkedUpload(port, cookie, bot.json.id, 26_214_401, "over.txt");
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(rejected.body).toContain("upload_too_large");
      const names = await system.artifact.findMany({
        where: { botId: bot.json.id },
        select: { name: true },
      });
      expect(names.map((row) => row.name).sort()).toEqual(["at.txt", "under.txt"]);

      const during = await owned();
      const partial = http.request({
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/rpc/artifacts/create",
        headers: {
          "content-type": "application/json",
          cookie,
          origin,
          "transfer-encoding": "chunked",
        },
      });
      const partialBody = `{"json":{"botId":${JSON.stringify(bot.json.id)},"name":"partial.txt","mimeType":"text/plain","contentBase64":"${Buffer.from("partial-bytes").toString("base64")}`;
      partial.on("error", () => undefined);
      partial.write(partialBody);
      await withTimeout(partialReceived, 5_000, "server did not acknowledge the partial upload");
      partial.destroy();
      await withTimeout(partialForward, 5_000, "aborted upload did not finish closing");
      expect(await owned()).toBe(during);

      const callsBeforeFrame = appCalls;
      const framed = await withTimeout(
        rawHttp(
          port,
          `POST /rpc/artifacts/create HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nCookie: ${cookie}\r\nOrigin: ${origin}\r\n\r\nZZ\r\n`,
        ),
        5_000,
        "malformed chunk did not produce a parser response",
      );
      expect(parserCodes).toContain("HPE_INVALID_CHUNK_SIZE");
      expect(framed.startsWith("HTTP/1.1 400")).toBe(true);
      expect(appCalls).toBe(callsBeforeFrame);
      expect(await owned()).toBe(before + 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  180_000,
);

it.skipIf(!databaseUrl)(
  "accepts a chunked upload through the production HTTP adapter",
  async () => {
    process.env.BETTER_AUTH_SECRET ??= "phase1-auth-secret-phase1-auth-secret";
    process.env.ENCRYPTION_KEY ??= "phase1-encryption-key-phase1-encryption";
    process.env.SCREEN_PROXY_SECRET ??= "phase1-screen-proxy-secret-32chars";
    process.env.SANDBOX_SUPERVISOR_TOKEN ??= "phase1-supervisor-token-32chars-xx";
    delete process.env.MAX_UPLOAD_SIZE_MB;
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-phase1-hono-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
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
    const server = serve({ fetch: handles.app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const signup = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `phase1-hono-${Date.now()}@example.test`,
          password: "test-password-123",
          name: "Hono",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie =
        signup.headers
          .getSetCookie?.()
          .map((value) => value.split(";")[0])
          .join("; ") ?? "";
      const bot = (await (
        await fetch(`http://127.0.0.1:${port}/rpc/bots/create`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: JSON.stringify({
            json: {
              name: "Hono bot",
              title: "",
              description: "",
              instructions: "",
              notifyOnFinish: false,
            },
          }),
        })
      ).json()) as { json: { id: string } };
      const uploaded = await chunkedUpload(port, cookie, bot.json.id, 32, "adapter.txt");
      expect(uploaded.status).toBe(200);
      const names = await asSystem(handles.prisma).artifact.findMany({
        where: { botId: bot.json.id },
        select: { name: true },
      });
      expect(names.map((row) => row.name)).toEqual(["adapter.txt"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  60_000,
);

async function forwardStream(
  fetchApp: (request: Request) => Promise<Response> | Response,
  request: IncomingMessage,
  body: ReadableStream<Uint8Array>,
  response: ServerResponse,
) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (key === "transfer-encoding" || key === "content-length") continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  try {
    const appResponse = await fetchApp(
      new Request(`http://127.0.0.1${request.url ?? "/"}`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    const payload = Buffer.from(await appResponse.arrayBuffer());
    if (!response.headersSent) {
      response.writeHead(appResponse.status, Object.fromEntries(appResponse.headers.entries()));
    }
    response.end(payload);
  } catch {
    if (!response.headersSent) response.writeHead(400);
    response.end();
  }
}

function chunkedUpload(port: number, cookie: string, botId: string, size: number, name: string) {
  const body = JSON.stringify({
    json: {
      botId,
      name,
      mimeType: "text/plain",
      contentBase64: Buffer.alloc(size, 1).toString("base64"),
    },
  });
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/rpc/artifacts/create",
        headers: {
          "content-type": "application/json",
          cookie,
          origin,
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    const step = 64 * 1024;
    for (let offset = 0; offset < body.length; offset += step) {
      request.write(body.slice(offset, offset + step));
    }
    request.end();
  });
}

function rawHttp(port: number, payload: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

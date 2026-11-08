// Phase-1 test helper. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Starts a new PostgreSQL cluster in a temporary directory. It does not read DATABASE_URL.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";

export async function startFixtureCluster(): Promise<{ url: URL; stop: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "phase1-cluster-"));
  const data = join(root, "data");
  let started = false;
  try {
    const password = randomBytes(18).toString("hex");
    const passwordFile = join(root, "password");
    await writeFile(passwordFile, password, { mode: 0o600 });
    await run(join(BIN, "initdb"), [
      "-D",
      data,
      "-U",
      "fixture_admin",
      "--pwfile",
      passwordFile,
      "--auth-local=scram-sha-256",
      "--auth-host=scram-sha-256",
    ]);
    const port = await freePort();
    await run(join(BIN, "pg_ctl"), [
      "-D",
      data,
      "-l",
      join(root, "server.log"),
      "-o",
      `-p ${port} -k ${root} -c listen_addresses=127.0.0.1`,
      "start",
    ]);
    started = true;
    await waitUntilReady(port);
    const url = new URL("postgres://fixture_admin@127.0.0.1/postgres");
    url.port = String(port);
    url.password = password;
    return {
      url,
      stop: () => stopOwnedServer(data, root),
    };
  } catch (error) {
    if (started) await stopOwnedServer(data, root);
    else await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function stopOwnedServer(data: string, root: string): Promise<void> {
  const stopped = await run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]).then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : "fixture server stop failed"),
  );
  if (await serverIsRunning(data)) {
    throw new Error(
      stopped
        ? `fixture server did not stop: ${stopped}`
        : "fixture server did not stop after pg_ctl stop",
    );
  }
  await rm(root, { recursive: true, force: true });
}

function serverIsRunning(data: string): Promise<boolean> {
  return run(join(BIN, "pg_ctl"), ["-D", data, "status"]).then(
    () => true,
    () => false,
  );
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || stdout || error.message));
      else resolve();
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitUntilReady(port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await run(join(BIN, "pg_isready"), ["-h", "127.0.0.1", "-p", String(port)]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("fixture postgres did not accept connections");
}

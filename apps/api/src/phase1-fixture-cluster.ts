// Phase-1 test helper. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Starts a new PostgreSQL cluster in a temporary directory. It does not read DATABASE_URL.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixtureHandle } from "@rakazo/db";
import { beginFixtureClose, registerFixtureAllocation, revokeFixtureAllocation } from "@rakazo/db";

const BIN = "/usr/lib/postgresql/16/bin";
/** pg_ctl status exit when this data directory has no running server. */
const SERVER_NOT_RUNNING = 3;

export type FixtureCommandResult = { code: number; stdout: string; stderr: string };
export type FixtureCommandRunner = (
  command: string,
  args: string[],
) => Promise<FixtureCommandResult>;

export async function startFixtureCluster(
  control: {
    run?: FixtureCommandRunner;
    remove?: (path: string) => Promise<void>;
    directory?: string;
  } = {},
): Promise<{ url: URL; handle: FixtureHandle; stop: () => Promise<void> }> {
  const run = control.run ?? runCommand;
  const remove = control.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const root = control.directory ?? (await mkdtemp(join(tmpdir(), "phase1-cluster-")));
  const data = join(root, "data");
  let startAttempted = false;
  try {
    const password = randomBytes(18).toString("hex");
    const passwordFile = join(root, "password");
    await writeFile(passwordFile, password, { mode: 0o600 });
    await mustRun(run, join(BIN, "initdb"), [
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
    startAttempted = true;
    await mustRun(run, join(BIN, "pg_ctl"), [
      "-D",
      data,
      "-l",
      join(root, "server.log"),
      "-o",
      `-p ${port} -k ${root} -c listen_addresses=127.0.0.1`,
      "start",
    ]);
    await waitUntilReady(port, run);
    const url = new URL("postgres://fixture_admin@127.0.0.1/postgres");
    url.port = String(port);
    url.password = password;
    const handle = registerFixtureAllocation({
      host: "127.0.0.1",
      port,
      database: "postgres",
      users: [
        "fixture_admin",
        "rakazo_phase1_api",
        "rakazo_phase1_runtime",
        "rakazo_credential_worker",
      ],
      dataDirectory: data,
      root,
    });
    return {
      url,
      handle,
      stop: createFixtureStopController({ handle, data, root, run, remove }).stop,
    };
  } catch (error) {
    await cleanupFixtureDataDirectory({ data, root, startAttempted, run, remove });
    throw error;
  }
}

/**
 * Authority ends when stop starts. Repeated calls retry only the phase that failed.
 * pg_ctl status 3 is the only confirmed-stopped code. Any other code, including 4, is not.
 */
export function createFixtureStopController(input: {
  handle: FixtureHandle;
  data: string;
  root: string;
  run: FixtureCommandRunner;
  remove: (path: string) => Promise<void>;
}): { stop: () => Promise<void> } {
  const progress = { confirmed: false, removed: false };
  return {
    stop: async () => {
      beginFixtureClose(input.handle);
      if (progress.removed) return;
      if (!progress.confirmed) {
        await input.run(join(BIN, "pg_ctl"), ["-D", input.data, "-m", "immediate", "stop"]);
        const status = await input.run(join(BIN, "pg_ctl"), ["-D", input.data, "status"]);
        if (status.code !== SERVER_NOT_RUNNING) {
          throw new Error(`fixture server stop uncertain: status exit ${status.code}`);
        }
        progress.confirmed = true;
        process.stdout.write("fixture-stop confirmed status=3\n");
      }
      await input.remove(input.root);
      progress.removed = true;
      process.stdout.write("fixture-stop removed\n");
      revokeFixtureAllocation(input.handle);
    },
  };
}

export async function cleanupFixtureDataDirectory(input: {
  data: string;
  root: string;
  startAttempted: boolean;
  run: FixtureCommandRunner;
  remove: (path: string) => Promise<void>;
}): Promise<void> {
  if (!input.startAttempted) {
    await input.remove(input.root);
    return;
  }
  const stopped = await input.run(join(BIN, "pg_ctl"), [
    "-D",
    input.data,
    "-m",
    "immediate",
    "stop",
  ]);
  const status = await input.run(join(BIN, "pg_ctl"), ["-D", input.data, "status"]);
  if (status.code !== SERVER_NOT_RUNNING) {
    const detail = status.code === 0 ? "server still running" : `status exit ${status.code}`;
    const stopDetail = stopped.code === 0 ? "" : "stop failed";
    throw new Error(
      stopDetail
        ? `fixture server stop uncertain: ${stopDetail}; ${detail}`
        : `fixture server stop uncertain: ${detail}`,
    );
  }
  process.stdout.write("fixture-stop confirmed status=3\n");
  await input.remove(input.root);
  process.stdout.write("fixture-stop removed\n");
}

function mustRun(run: FixtureCommandRunner, command: string, args: string[]): Promise<void> {
  return run(command, args).then((result) => {
    if (result.code !== 0)
      throw new Error(result.stderr || result.stdout || "fixture command failed");
  });
}

function runCommand(command: string, args: string[]): Promise<FixtureCommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, (error, stdout, stderr) => {
      const code =
        error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
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

async function waitUntilReady(port: number, run: FixtureCommandRunner): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await run(join(BIN, "pg_isready"), ["-h", "127.0.0.1", "-p", String(port)]);
    if (ready.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fixture postgres did not accept connections");
}

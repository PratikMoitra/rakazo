// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { fixtureChildEnv, fixtureEnvKeys } from "./phase1-fixture-env.js";

it("does not copy an ambient sentinel into a fixture child", async () => {
  process.env.PHASE1_SENTINEL_SHOULD_NOT_LEAK = "ambient";
  process.env.REALTIME_DATABASE_URL = "postgres://ambient@127.0.0.1:1/ambient";
  const env = fixtureChildEnv({
    databaseUrl: "postgres://fixture@127.0.0.1:1/fixture",
    migrationUrl: "postgres://fixture@127.0.0.1:1/fixture",
    workerUrl: "postgres://worker@127.0.0.1:1/fixture",
    realtimeUrl: "postgres://fixture@127.0.0.1:1/fixture",
  });
  expect(env.PHASE1_SENTINEL_SHOULD_NOT_LEAK).toBeUndefined();
  expect(env.REALTIME_DATABASE_URL).toBe("postgres://fixture@127.0.0.1:1/fixture");
  expect(Object.keys(env).sort()).toEqual([...fixtureEnvKeys()].sort());
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write(process.env.PHASE1_SENTINEL_SHOULD_NOT_LEAK ?? '')"],
      { env },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error("sentinel child failed"));
    });
  });
  expect(output).toBe("");
  delete process.env.PHASE1_SENTINEL_SHOULD_NOT_LEAK;
  delete process.env.REALTIME_DATABASE_URL;
});

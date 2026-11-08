// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Each acceptance suite gets a new cluster. This file does not read a preserved database URL.
import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { startFixtureCluster } from "./phase1-fixture-cluster.js";
import { ownedAcceptanceEnv, runOwnedProcess } from "./phase1-owned-acceptance.js";

const enabled = existsSync("/usr/lib/postgresql/16/bin/initdb");
const suites = [
  ["messaging", "packages/adapters/src/messaging-installations.postgres.test.ts"],
  ["foundation", "apps/api/src/phase1-foundation.postgres.test.ts"],
  ["rls", "apps/api/src/phase1-rls.postgres.test.ts"],
  ["wire", "apps/api/src/phase1-wire.postgres.test.ts"],
] as const;

function redact(output: string): string {
  return output.replace(/postgres(?:ql)?:\/\/\S+/g, "[database]");
}

it.skipIf(!enabled)(
  "runs each acceptance suite on a separate owned cluster",
  async () => {
    for (const [name, file] of suites) {
      const cluster = await startFixtureCluster();
      const env = ownedAcceptanceEnv(cluster.url, `${name}-${cluster.url.port}`);
      try {
        const migrated = await runOwnedProcess(
          "pnpm",
          ["--filter", "@rakazo/api", "db:migrate"],
          env,
        );
        if (migrated.code !== 0)
          throw new Error(`${name} migrate failed\n${redact(migrated.output)}`);
        const ran = await runOwnedProcess(
          "pnpm",
          ["exec", "vitest", "run", file, "--reporter=dot"],
          env,
        );
        const report = redact(ran.output);
        if (ran.code !== 0 || !/\d+ passed/.test(report) || /\d+ skipped/.test(report)) {
          throw new Error(`${name} failed\n${report}`);
        }
      } finally {
        await cluster.stop();
      }
    }
  },
  900_000,
);

it.skipIf(!enabled)(
  "allocates concurrent acceptance processes on distinct clusters",
  async () => {
    const [first, second] = await Promise.all([startFixtureCluster(), startFixtureCluster()]);
    try {
      const envA = ownedAcceptanceEnv(first.url, "concurrent-a");
      const envB = ownedAcceptanceEnv(second.url, "concurrent-b");
      expect(first.url.port).not.toBe(second.url.port);
      const probe = [
        "exec",
        "vitest",
        "run",
        "apps/api/src/phase1-owned-acceptance-probe.postgres.test.ts",
        "--reporter=verbose",
      ];
      const [ranA, ranB] = await Promise.all([
        runOwnedProcess("pnpm", probe, envA),
        runOwnedProcess("pnpm", probe, envB),
      ]);
      expect(ranA.code, redact(ranA.output)).toBe(0);
      expect(ranB.code, redact(ranB.output)).toBe(0);
      expect(ranA.output).toContain(`owned-target concurrent-a ${first.url.port}`);
      expect(ranB.output).toContain(`owned-target concurrent-b ${second.url.port}`);
      expect(ranA.output).not.toContain(`concurrent-b ${second.url.port}`);
      expect(ranB.output).not.toContain(`concurrent-a ${first.url.port}`);
    } finally {
      await first.stop();
      await second.stop();
    }
  },
  180_000,
);

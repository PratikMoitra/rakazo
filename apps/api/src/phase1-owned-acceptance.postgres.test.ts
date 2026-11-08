// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Each acceptance suite gets a new cluster. This file does not read a preserved database URL.
import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { startFixtureCluster } from "./phase1-fixture-cluster.js";
import {
  allocateAll,
  ownedAcceptanceEnv,
  runOwnedProcess,
  stopAll,
} from "./phase1-owned-acceptance.js";

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
      const env = ownedAcceptanceEnv(cluster.url, cluster.handle);
      const children: Array<{ killAndWait: () => Promise<void> }> = [];
      try {
        const migrate = runOwnedProcess("pnpm", ["--filter", "@rakazo/api", "db:migrate"], env);
        children.push(migrate);
        const migrated = await migrate.result;
        if (migrated.code !== 0 || migrated.error)
          throw new Error(`${name} migrate failed\n${redact(migrated.output)}`);
        const ranChild = runOwnedProcess(
          "pnpm",
          ["exec", "vitest", "run", file, "--reporter=dot"],
          env,
        );
        children.push(ranChild);
        const ran = await ranChild.result;
        const report = redact(ran.output);
        if (
          ran.code !== 0 ||
          ran.error ||
          !/\d+ passed/.test(report) ||
          /\d+ skipped/.test(report)
        ) {
          throw new Error(`${name} failed\n${report}`);
        }
      } finally {
        await stopAll(children.map((child) => () => child.killAndWait()));
        await cluster.stop();
      }
    }
  },
  900_000,
);

it.skipIf(!enabled)(
  "allocates concurrent acceptance processes on distinct clusters",
  async () => {
    let clusters: Awaited<ReturnType<typeof startFixtureCluster>>[] = [];
    try {
      clusters = await allocateAll([() => startFixtureCluster(), () => startFixtureCluster()]);
      const first = clusters[0];
      const second = clusters[1];
      if (!first || !second) throw new Error("fixture allocation failed");
      const envA = ownedAcceptanceEnv(first.url, first.handle);
      const envB = ownedAcceptanceEnv(second.url, second.handle);
      expect(first.url.port).not.toBe(second.url.port);
      const probe = [
        "exec",
        "vitest",
        "run",
        "apps/api/src/phase1-owned-acceptance-probe.postgres.test.ts",
        "--reporter=verbose",
      ];
      const childA = runOwnedProcess("pnpm", probe, envA);
      const childB = runOwnedProcess("pnpm", probe, envB);
      try {
        const [ranA, ranB] = await Promise.all([childA.result, childB.result]);
        expect(ranA.code, redact(ranA.output)).toBe(0);
        expect(ranB.code, redact(ranB.output)).toBe(0);
        expect(ranA.output).toContain(`owned-target ${first.handle.id} ${first.url.port}`);
        expect(ranB.output).toContain(`owned-target ${second.handle.id} ${second.url.port}`);
      } finally {
        await stopAll([() => childA.killAndWait(), () => childB.killAndWait()]);
      }
    } finally {
      await stopAll(clusters.map((cluster) => () => cluster.stop()));
    }
  },
  180_000,
);

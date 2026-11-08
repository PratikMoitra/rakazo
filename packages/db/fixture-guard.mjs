// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Plain script so Prisma's config loader can authenticate an allocation without the TS graph.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const parse = require("pg-connection-string");
const OWNERSHIP_REFUSAL = "database target is not an owned fixture allocation";
const STALE_REFUSAL = "fixture allocation is stale";

/** Mutating Prisma commands require a live allocation. Generate does not call this. */
export function assertMutatingDatasource(url) {
  if (process.env.RAKAZO_DISPOSABLE_FIXTURE !== "1") throw new Error(OWNERSHIP_REFUSAL);
  const handlePath = process.env.RAKAZO_FIXTURE_HANDLE;
  const token = process.env.RAKAZO_FIXTURE_TOKEN;
  if (!url || !handlePath || !token) throw new Error(OWNERSHIP_REFUSAL);
  let allocation;
  try {
    allocation = JSON.parse(readFileSync(handlePath, "utf8"));
  } catch {
    throw new Error(OWNERSHIP_REFUSAL);
  }
  if (
    !allocation ||
    allocation.token !== token ||
    allocation.state !== "open" ||
    !Number.isInteger(allocation.generation)
  ) {
    throw new Error(OWNERSHIP_REFUSAL);
  }
  if (process.env.RAKAZO_OWNED_FIXTURE_ID && process.env.RAKAZO_OWNED_FIXTURE_ID !== allocation.id) {
    throw new Error(OWNERSHIP_REFUSAL);
  }
  if (!existsSync(allocation.dataDirectory)) throw new Error(STALE_REFUSAL);
  const plan = parse(url);
  const host = String(plan.host ?? "").toLowerCase();
  const port = plan.port ? Number(plan.port) : 5432;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(
      "plaintext database transport requires an explicit disposable fixture on literal loopback",
    );
  }
  if (
    host !== allocation.host ||
    port !== allocation.port ||
    !allocation.databases?.includes(plan.database) ||
    !allocation.users?.includes(plan.user)
  ) {
    throw new Error(OWNERSHIP_REFUSAL);
  }
}

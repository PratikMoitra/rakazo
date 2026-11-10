// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Direct package migrate scripts enter here. They do not fall through to an unowned database.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployMigrations } from "./deferred-migrations.js";
import { OWNERSHIP_REFUSAL } from "./fixture-allocation.js";
import { fixtureEngineUrl } from "./fixture-transport.js";

const disabled = "prisma migrate dev is disabled in the fixture workflow";

try {
  if (process.argv.includes("--dev")) {
    process.stderr.write(`${disabled}\n`);
    process.exit(1);
  }
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (!migrationUrl || !process.env.RAKAZO_FIXTURE_HANDLE || !process.env.RAKAZO_FIXTURE_TOKEN) {
    throw new Error(OWNERSHIP_REFUSAL);
  }
  fixtureEngineUrl(migrationUrl);
  if (process.env.RAKAZO_FIXTURE_ENGINE_SMOKE === "1") {
    process.stdout.write("fixture migration delegation accepted\n");
    process.exit(0);
  }
  await deployMigrations({
    migrationUrl,
    dbPackageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : OWNERSHIP_REFUSAL}\n`);
  process.exit(1);
}

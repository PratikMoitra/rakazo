// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Direct package migrate scripts enter here. They do not fall through to an unowned database.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployMigrations } from "./deferred-migrations.js";
import { OWNERSHIP_REFUSAL } from "./fixture-allocation.js";

if (process.argv.includes("--dev")) {
  throw new Error("prisma migrate dev is disabled in the fixture workflow");
}
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl || !process.env.RAKAZO_FIXTURE_HANDLE) {
  throw new Error(OWNERSHIP_REFUSAL);
}
await deployMigrations({
  migrationUrl,
  dbPackageDir: `${path.dirname(fileURLToPath(import.meta.url))}/..`,
});

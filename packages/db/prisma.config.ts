import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureWorkflow = Boolean(
  process.env.RAKAZO_FIXTURE_HANDLE || process.env.RAKAZO_DISPOSABLE_FIXTURE === "1",
);
if (!fixtureWorkflow) {
  const rootEnv = path.resolve(here, "../../.env");
  if (existsSync(rootEnv)) config({ path: rootEnv });
  config();
}

const migrationUrl = fixtureWorkflow
  ? process.env.DATABASE_MIGRATION_URL
  : process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
const generating = process.argv.includes("generate");
if (!generating && (!migrationUrl || (fixtureWorkflow && !process.env.RAKAZO_FIXTURE_HANDLE))) {
  throw new Error("fixture migration refuses an unowned database url");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    // The migrate command passes a copy without the deferred migrations it holds back.
    path: process.env.RAKAZO_MIGRATIONS_PATH || "prisma/migrations",
  },
  datasource: {
    // Migrations run as the owner role; DATABASE_URL may be the app's runtime login.
    url: migrationUrl || "postgres://generate:unused@127.0.0.1:1/generate",
  },
});

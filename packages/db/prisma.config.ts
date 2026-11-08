import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
import { assertMutatingDatasource } from "./fixture-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Generate does not open a database. Every other command through this config must
// match a live fixture allocation. Dotenv is not loaded, so a missing flag cannot
// select an ambient database URL.
const generating = process.argv.includes("generate");
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!generating) assertMutatingDatasource(migrationUrl);

export default defineConfig({
  schema: path.join(here, "prisma/schema.prisma"),
  migrations: {
    // The migrate command passes a copy without the deferred migrations it holds back.
    path: process.env.RAKAZO_MIGRATIONS_PATH || "prisma/migrations",
  },
  datasource: {
    // Migrations run as the owner role; DATABASE_URL may be the app's runtime login.
    url: migrationUrl || "postgres://generate:unused@127.0.0.1:1/generate",
  },
});

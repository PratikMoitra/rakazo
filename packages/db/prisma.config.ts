import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
import {
  assertTypedSqlDisabled,
  canonicalMutatingDatasource,
  isNonconnectingGenerate,
} from "./src/fixture-command.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// Plain generate does not open a database. TypedSQL generate does, and this fixture disables it.
// Dotenv is not loaded, so a missing flag cannot select an ambient database URL.
assertTypedSqlDisabled(process.argv);
const generating = isNonconnectingGenerate(process.argv);
const migrationUrl = generating
  ? process.env.DATABASE_MIGRATION_URL
  : canonicalMutatingDatasource(process.env.DATABASE_MIGRATION_URL);

export default defineConfig({
  schema: path.join(here, "prisma/schema.prisma"),
  migrations: {
    path: process.env.RAKAZO_MIGRATIONS_PATH || "prisma/migrations",
  },
  datasource: {
    url: migrationUrl || "postgres://generate:unused@127.0.0.1:1/generate",
  },
});

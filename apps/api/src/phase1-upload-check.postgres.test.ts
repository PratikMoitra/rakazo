// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const checkSql = readFileSync(
  new URL(
    "../../../packages/db/prisma/migrations/20261130130100_upload_policy_check/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

it.skipIf(!databaseUrl)(
  "applies the upload check on a fresh database and refuses a dirty pre-existing row",
  async () => {
    const source = new URL(databaseUrl!);
    const rehearsal = "rakazo_phase1_check_rehearsal";
    const admin = psql(source, `DROP DATABASE IF EXISTS ${rehearsal}`);
    await admin;
    await psql(source, `CREATE DATABASE ${rehearsal}`);
    const target = new URL(source.toString());
    target.pathname = `/${rehearsal}`;
    try {
      await runMigrate(target);
      for (const value of ["NULL", "1048576", "26214400"]) {
        const inserted = await psql(
          target,
          `INSERT INTO deployment_settings (id, "maxUploadSizeBytes", "createdAt", "updatedAt") VALUES ('bound-${value}', ${value}, now(), now())`,
        );
        expect(inserted.ok).toBe(true);
      }
      for (const value of ["0", "1", "-1", "1048577", "27262976"]) {
        const rejected = await psql(
          target,
          `INSERT INTO deployment_settings (id, "maxUploadSizeBytes", "createdAt", "updatedAt") VALUES ('bad-${value}', ${value}, now(), now())`,
        );
        expect(rejected.ok).toBe(false);
        expect(rejected.text).toContain("deployment_settings_max_upload_bytes_check");
      }
      await psql(
        target,
        `ALTER TABLE deployment_settings DROP CONSTRAINT deployment_settings_max_upload_bytes_check`,
      );
      const dirty = await psql(
        target,
        `INSERT INTO deployment_settings (id, "maxUploadSizeBytes", "createdAt", "updatedAt") VALUES ('dirty', 1, now(), now())`,
      );
      expect(dirty.ok).toBe(true);
      const blocked = await psql(target, checkSql);
      expect(blocked.ok).toBe(false);
      expect(blocked.text).toContain("deployment_settings_max_upload_bytes_check");
      const still = await psql(
        target,
        `SELECT "maxUploadSizeBytes" = 1 AS unchanged FROM deployment_settings WHERE id = 'dirty'`,
      );
      expect(still.ok).toBe(true);
      expect(still.text).toContain("t");
      expect(still.text).not.toMatch(/UPDATE \d/);
    } finally {
      await psql(source, `DROP DATABASE IF EXISTS ${rehearsal} WITH (FORCE)`);
    }
  },
  180_000,
);

function psql(url: URL, sql: string) {
  return new Promise<{ ok: boolean; text: string }>((resolve) => {
    execFile(
      "psql",
      [
        "-h",
        url.hostname,
        "-p",
        url.port || "5432",
        "-U",
        decodeURIComponent(url.username),
        "-d",
        url.pathname.slice(1),
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) } },
      (error, stdout, stderr) => {
        resolve({ ok: !error, text: `${stdout}\n${stderr}` });
      },
    );
  });
}

function runMigrate(url: URL) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      "pnpm",
      [
        "--filter",
        "@rakazo/db",
        "exec",
        "prisma",
        "migrate",
        "deploy",
        "--schema",
        "prisma/schema.prisma",
      ],
      {
        cwd: new URL("../../../packages/db", import.meta.url).pathname,
        env: {
          ...process.env,
          DATABASE_URL: url.toString(),
          DATABASE_MIGRATION_URL: url.toString(),
        },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || stdout || error.message));
        else resolve();
      },
    );
  });
}

// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Loads Prisma config in a fresh process. Generate is the only nonconnecting command.
if (process.env.RAKAZO_CONFIG_ARGV) {
  process.argv = ["node", "prisma", ...process.env.RAKAZO_CONFIG_ARGV.split(/\s+/)];
}
const loaded = await import("./prisma.config.ts");
if (process.env.RAKAZO_CHECK_ENGINE_URL === "1") {
  const url = loaded.default?.datasource?.url;
  if (url !== process.env.DATABASE_MIGRATION_URL) {
    process.stderr.write("engine-url-mismatch\n");
    process.exit(1);
  }
  process.stdout.write("engine-url-match\n");
}

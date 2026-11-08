// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Loads Prisma config in a fresh process. Generate is the only nonconnecting command.
if (process.env.RAKAZO_CONFIG_ARGV) {
  process.argv = ["node", "prisma", ...process.env.RAKAZO_CONFIG_ARGV.split(/\s+/)];
}
await import("./prisma.config.ts");

// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { OWNERSHIP_REFUSAL } from "./fixture-allocation.js";
import { fixtureEngineUrl } from "./fixture-transport.js";

/** True only when Prisma's own subcommand is generate, not when an operand is named generate. */
export function isNonconnectingGenerate(argv: readonly string[]): boolean {
  const positional = argv.filter((arg) => arg !== "--" && !arg.startsWith("-"));
  const bin = positional.findIndex(
    (arg) =>
      /(^|[\\/])prisma$/.test(arg) ||
      arg.includes("prisma/build/index.js") ||
      arg.includes("prisma\\build\\index.js"),
  );
  if (bin < 0) return false;
  return positional[bin + 1] === "generate";
}

/** Validates a mutating datasource and returns the canonical engine URL. */
export function canonicalMutatingDatasource(url: string | undefined): string {
  if (!url) throw new Error(OWNERSHIP_REFUSAL);
  return fixtureEngineUrl(url);
}

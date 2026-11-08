// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { OWNERSHIP_REFUSAL } from "./fixture-allocation.js";
import { canonicalEngineInput } from "./fixture-transport.js";

// Top-level flags from the pinned Prisma 7.10.1 CLI. String flags consume a value.
// Anything else fails closed so a flag value cannot be mistaken for generate.
const BOOLEAN_FLAGS = new Set([
  "--help",
  "--version",
  "--json",
  "--experimental",
  "--preview-feature",
  "--early-access",
]);
const STRING_FLAGS = new Set(["--config", "--telemetry-information"]);
const FLAG_ALIASES: Record<string, string> = { "-h": "--help", "-v": "--version" };

function prismaBinary(token: string): boolean {
  return (
    /(^|[\\/])prisma$/.test(token) ||
    token.endsWith(`${"/"}prisma/build/index.js`) ||
    token.endsWith("\\prisma\\build\\index.js")
  );
}

/**
 * True only for Prisma's generate subcommand. A string flag's value, including one named
 * generate, is not the command. Unknown or incomplete flags are not generate.
 */
export function isNonconnectingGenerate(argv: readonly string[]): boolean {
  const bin = argv.findIndex(prismaBinary);
  if (bin < 0) return false;
  const rest = argv.slice(bin + 1);
  let sawHelpOrVersion = false;
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--") {
      positional.push(...rest.slice(index + 1));
      break;
    }
    if (!token.startsWith("-")) {
      positional.push(...rest.slice(index));
      break;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const flag = FLAG_ALIASES[name] ?? name;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inline !== undefined) return false;
      if (flag === "--help" || flag === "--version") sawHelpOrVersion = true;
      continue;
    }
    if (!STRING_FLAGS.has(flag)) return false;
    if (inline !== undefined) {
      if (inline.length === 0) return false;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value === "--") return false;
    index += 1;
  }
  return !sawHelpOrVersion && positional[0] === "generate";
}

/** Validates a mutating datasource, including the internal lock timeout, and returns it. */
export function canonicalMutatingDatasource(url: string | undefined): string {
  if (!url) throw new Error(OWNERSHIP_REFUSAL);
  return canonicalEngineInput(url);
}

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
// Generate subcommand flags from the pinned Prisma 7.10.1 CLI. --sql introspects the datasource.
const GENERATE_BOOLEAN = new Set(["--help", "--watch", "--no-hints", "--require-models", "--sql"]);
const GENERATE_STRING = new Set(["--schema", "--config", "--telemetry-information", "--generator"]);
const GENERATE_ALIASES: Record<string, string> = { "-h": "--help" };

export const TYPED_SQL_REFUSAL = "TypedSQL generation is disabled for this fixture";

export type FixtureCommand = "generate" | "typed-sql" | "mutating";

function prismaBinary(token: string): boolean {
  return (
    /(^|[\\/])prisma$/.test(token) ||
    token.endsWith(`${"/"}prisma/build/index.js`) ||
    token.endsWith("\\prisma\\build\\index.js")
  );
}

function consumeFlags(
  tokens: readonly string[],
  booleanFlags: ReadonlySet<string>,
  stringFlags: ReadonlySet<string>,
  aliases: Record<string, string>,
): { ok: boolean; positional: string[]; flags: Set<string> } {
  const positional: string[] = [];
  const flags = new Set<string>();
  const failed = { ok: false, positional, flags };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") return failed;
    if (!token.startsWith("-")) {
      positional.push(...tokens.slice(index));
      break;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const flag = aliases[name] ?? name;
    if (booleanFlags.has("--sql") && (flag === "--sql" || name === "--sql")) {
      flags.add("--sql");
      continue;
    }
    if (booleanFlags.has(flag)) {
      if (inline !== undefined) return failed;
      flags.add(flag);
      continue;
    }
    if (!stringFlags.has(flag)) return failed;
    flags.add(flag);
    if (inline !== undefined) {
      if (inline.length === 0) return failed;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value === "--") return failed;
    index += 1;
  }
  return { ok: true, positional, flags };
}

/**
 * Plain generate does not open a database. TypedSQL (`--sql`) does, so it is not that command.
 * Unknown or incomplete flags are mutating and must authenticate an allocation.
 */
export function classifyFixtureCommand(argv: readonly string[]): FixtureCommand {
  const bin = argv.findIndex(prismaBinary);
  if (bin < 0) return "mutating";
  const top = consumeFlags(argv.slice(bin + 1), BOOLEAN_FLAGS, STRING_FLAGS, FLAG_ALIASES);
  if (!top.ok || top.flags.has("--help") || top.flags.has("--version")) return "mutating";
  if (top.positional[0] !== "generate") return "mutating";
  const sub = consumeFlags(
    top.positional.slice(1),
    GENERATE_BOOLEAN,
    GENERATE_STRING,
    GENERATE_ALIASES,
  );
  if (sub.flags.has("--sql")) return "typed-sql";
  if (!sub.ok || sub.positional.length > 0) return "mutating";
  return "generate";
}

/** True only for Prisma generate without TypedSQL. A flag value named generate is not the command. */
export function isNonconnectingGenerate(argv: readonly string[]): boolean {
  return classifyFixtureCommand(argv) === "generate";
}

/** Refuses datasource introspection. This does not open an engine or read a schema. */
export function assertTypedSqlDisabled(argv: readonly string[]): void {
  if (classifyFixtureCommand(argv) === "typed-sql") throw new Error(TYPED_SQL_REFUSAL);
}

/** Validates a mutating datasource, including the internal lock timeout, and returns it. */
export function canonicalMutatingDatasource(url: string | undefined): string {
  if (!url) throw new Error(OWNERSHIP_REFUSAL);
  return canonicalEngineInput(url);
}

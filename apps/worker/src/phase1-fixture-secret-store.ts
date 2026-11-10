// Phase-1 test fixture. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Imported only by the fixture entrypoint. The production build does not include that entrypoint.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  AdapterContext,
  SecretChangeListener,
  SecretContext,
  SecretPutOptions,
  SecretStore,
} from "@rakazo/adapter-kit";

/** File-backed dummy for the phase-1 worker fixture entrypoint. Not a secret backend. */
export function phase1FixtureSecretStore(
  filePath: string,
  options: { crashAfterDelete?: boolean } = {},
): SecretStore {
  const listeners = new Set<SecretChangeListener>();
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>) => {
    const next = `${filePath}.tmp`;
    writeFileSync(next, JSON.stringify(data));
    renameSync(next, filePath);
  };
  return {
    describe: () => ({
      id: "phase1-dummy",
      contractVersion: "0",
      adapterVersion: "0",
      capabilities: { rotate: false, degraded: false },
    }),
    async put(plaintext: string, _context: AdapterContext, options?: SecretPutOptions) {
      const data = read();
      const ref = `dummy-${randomUUID()}`;
      data[ref] = plaintext;
      write(data);
      return { id: options?.recordId ?? ref, ref, ciphertext: ref };
    },
    async load(ref: string, _context: SecretContext) {
      const value = read()[ref];
      if (value === undefined) throw Object.assign(new Error("absent"), { code: "not_found" });
      return value;
    },
    async delete(ref: string, _context: SecretContext) {
      const data = read();
      if (data[ref] === undefined) throw Object.assign(new Error("absent"), { code: "not_found" });
      delete data[ref];
      write(data);
      for (const listener of listeners) listener(ref);
      if (options.crashAfterDelete) process.exit(75);
    },
    redact: (value: string) => value,
    onChange(listener: SecretChangeListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {},
    async close() {},
  };
}

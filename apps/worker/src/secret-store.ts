import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  AdapterContext,
  RealtimeFanout,
  SecretChangeListener,
  SecretContext,
  SecretPutOptions,
  SecretStore,
} from "@rakazo/adapter-kit";
import { createSecretStore } from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core";

/** Worker composition without starting job hosts or database connections. */
export async function createWorkerSecretStore(
  source: NodeJS.ProcessEnv,
  realtime?: RealtimeFanout,
): Promise<SecretStore> {
  if (source.PHASE1_DUMMY_SECRET_STORE)
    return phase1DummySecretStore(source.PHASE1_DUMMY_SECRET_STORE);
  const store = createSecretStore(resolveEncryptionKey(source), source, realtime);
  await store.start();
  return store;
}

/** File-backed dummy used only by the phase-1 worker entrypoint test. Not a secret backend. */
function phase1DummySecretStore(filePath: string): SecretStore {
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
      if (process.env.PHASE1_DUMMY_CRASH_AFTER_DELETE === "1") process.exit(75);
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

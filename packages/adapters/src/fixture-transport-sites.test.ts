// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { PLAINTEXT_REFUSAL } from "@rakazo/db";
import { expect, it } from "vitest";
import { PostgresRealtimeFanout } from "./realtime.js";
import { migrateJobQueue } from "./wakeup.js";

const remote = "postgres://fixture:fixture@evil.example/db";

it("does not construct a realtime client or a queue migration for a remote url", async () => {
  let opened = 0;
  expect(() => {
    new PostgresRealtimeFanout({
      connectionString: remote,
      publisher: { query: async () => undefined },
      clientFactory: () => {
        opened += 1;
        throw new Error("constructed");
      },
    });
  }).toThrow(PLAINTEXT_REFUSAL);
  await expect(migrateJobQueue(remote)).rejects.toThrow(PLAINTEXT_REFUSAL);
  expect(opened).toBe(0);
});

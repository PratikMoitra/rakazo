// Phase-1 test helper. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
import { acceptanceChannels } from "@rakazo/db";
import { expect, it } from "vitest";

const channels = acceptanceChannels();

it.skipIf(!channels)("prints its owned database target", () => {
  expect(channels!.host === "127.0.0.1" || channels!.host === "::1").toBe(true);
  process.stdout.write(`owned-target ${channels!.clusterId} ${channels!.port}\n`);
});

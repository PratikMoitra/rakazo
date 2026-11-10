// Phase-1 test entry. Not a production command. Apache-2.0; see LICENSE.
import { performCredentialCleanup } from "@rakazo/adapters";
import { createPool } from "@rakazo/db";

const databaseUrl = process.env.DATABASE_WORKER_URL;
const workItemId = process.env.PHASE1_WORK_ITEM_ID;
if (!databaseUrl || !workItemId) throw new Error("cleanup process is missing its input");
const pool = createPool(databaseUrl);
let deleted = false;
await performCredentialCleanup(
  {
    pool,
    secretStore: {
      async delete() {
        deleted = true;
      },
    },
  },
  workItemId,
);
await pool.end();
process.stdout.write(deleted ? "deleted\n" : "absent\n");

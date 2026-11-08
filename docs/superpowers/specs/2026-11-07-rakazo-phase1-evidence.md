# Phase 1 evidence

Sanitized record for review. No connection strings, passwords, or production hosts. This is not a release. Alaric must re-review the new head. Phase 1 remains incomplete.

## Units

`MAX_UPLOAD_SIZE_MB` is a count of mebibytes, 1 through 25. The byte ceiling is 26214400. The environment parser rejects `26`, `26214400`, `0`, `-1`, and `1.5`. A stored policy is a byte count in steps of 1048576, at most 26214400. A stored value cannot raise an explicit environment ceiling. An invalid stored value fails closed to 1 byte with source `invalid`. The database check rejects any other non-null value.

The signed-in RPC body ceiling for a 26214400-byte file is 36001112 bytes. The limiter keeps that body, and the JSON parser and base64 decoder keep further copies. That is not a 25 MiB memory cap.

## Request shape

`phase1-foundation.postgres.test.ts` calls Hono `app.request`. Those are in-process application requests, not a listening socket.

`phase1-wire.postgres.test.ts` listens on `127.0.0.1` port 0. Node parses the chunked bytes. The app is called with that decoded body. A partial body is acknowledged before the socket is destroyed, and a bad chunk is rejected by the parser before the app is called.

## Tested

- In-process uploads of 26214399 and 26214400 bytes accepted, and 26214401 rejected with `upload_too_large`, on disposable Postgres.
- In-process chunked small upload accepted. Unfinished body returned `upload_incomplete`. A short Content-Length with a body over the ceiling returned 413.
- Listening-socket chunked uploads of 26214399 and 26214400 bytes accepted, and 26214401 rejected with `upload_too_large` and no artifact of that name. The server recorded a nonempty partial JSON body containing `contentBase64` before the client destroyed the socket. That request added no artifact. A chunk size of `ZZ` produced `HPE_INVALID_CHUNK_SIZE`, an HTTP 400, and no call into the upload route.
- Two organization owners were denied `uploadPolicy/set` on the route. The direct service call covered one of those owners and the unverified configured admin. The verified admin was then allowed. The change wrote one `upload.policy.changed` event with previous bytes, new bytes, and a sequence number. That sequence is the highest retained row plus one, not a lifetime counter. Repeating the same value did not write another.
- Two concurrent requests for different byte counts produced ordered events. Two later requests for the same new value, starting from a different stored value, produced one transition. The sequence chain links each previous value to the prior new value without using `createdAt`. A trigger that rejects that audit insert returned a server error and left the stored value and event count unchanged. The trigger is dropped in `finally`.
- An explicit environment ceiling locked the stored value for the verified admin.
- A run-saved file of 3 MiB was rejected after the stored policy was 1 or 2 MiB, through the same finalizer the worker uses. No separate worker process was started.
- Supervisor HTTP, still in-process, accepted a 26214400-byte file body past the size gate and rejected 26214401 with `upload_too_large` before starting a computer. A caller `maxFileBytes` of 1 did not shrink the process ceiling, and a caller `maxFileBytes` of 99999999 did not raise it. No Docker daemon was available.
- Scripted chat completed. Shutdown requeue returned the run to queued. A stale fence did not.
- Runtime role `rakazo_phase1_runtime` is not a superuser and does not have BYPASSRLS. `describeRowSecurity` reported enforced. `artifacts` and `messages` have row security on. Another space could not read the artifact through the API or through a tenant query.
- A login that is not the runtime role, with usage on `graphile_worker` and no table grants, was denied select, update, delete, and insert on `graphile_worker._private_jobs`. The runtime role could still select that table.
- Local email emulator captured the welcome message. No paid model call.
- Mobile source tests covered the advertised byte limit, a loopback default, a private custom server, and sign-in plus `me` against that server.
- On a fresh disposable database, the ordered migration chain applied. Null, 1048576, and 26214400 were accepted. 0, 1, -1, a non-mebibyte, and a value above 26214400 were rejected by the check. A pre-existing invalid row made the check statement fail and stayed unchanged.

## Queue boundary, credential cleanup only

The permanent no-reuse key is `sha256` of the domain string `rakazo-credential-object-v1:` plus the object reference. The raw reference stays on a non-terminal `credential_retirement` row and, for an uncommitted object, on `credential_orphan` until `retain_until` (one hour). `purge_dummy_orphans` deletes expired orphan rows only. It does not delete an external secret. That is a dummy bound, not an alert, a backlog age, or a cleanup SLA. Real orphan accumulation is not accepted. Rotation and disconnect still throw before creating work when the worker URL is unset.

Attach, capture, enqueue, and the installation trigger take `pg_advisory_xact_lock` on that fingerprint and then lock the fingerprint row, through commit. A second connection's restore insert waited on an uncommitted retiring update and then failed with SQLSTATE 23514. The API login cannot disable that trigger, set `session_replication_role` to `replica`, `SET ROLE` to the queue owner, or update the fingerprint table (SQLSTATE 42501). A database owner can still bypass this. It is not DBA-proof.

Claim returns `ready`, `busy`, `terminal`, or `missing`. A busy lease, a renewal that changes 0 rows, and a missing fingerprint throw `credential_cleanup_retry` or `credential_cleanup_invariant`. They are not success. Setting `leased_until` in the past let another claim take the row; the old fence renewed 0 rows. A delete that then threw left the secret gone and the row leased; after the lease was set in the past, the next attempt treated `not_found` as already deleted and completed. That is not an exactly-once external delete.

`pnpm --filter @rakazo/api db:migrate` runs the legacy-state preflight before Prisma DDL. On a fresh database, pending, leased, deleted, and skipped retirement rows plus one active ciphertext were left in place, and `_prisma_migrations` was not created. No converter and no delete runs to clear that guard. An existing `rakazo_credential_worker` role with no provenance row in that database was not altered: its password hash compared equal, and no migrations were written. The endpoint check connects with the migration login to the worker URL's host, port, and database and compares `system_identifier`. It does not trust the URL string alone.

The worker check starts `apps/worker/src/index.ts` through `tsx`. `PHASE1_DUMMY_SECRET_STORE` points that process at a file. One process deleted the retired object and exited 75. After the test cleared the Graphile lock and set the product lease in the past, a second process of the same entrypoint acknowledged the job. The current ciphertext remained. A committed legacy raw-reference job was left in the queue, and the next start exited non-zero with `legacy jobs are queued`. `apps/api/src/phase1-cleanup-once.ts` is not this evidence.

The runtime login still has Graphile access for every other job when migrate provisions separate URLs. That all-job gap stays open. This slice does not revoke those grants and is not a pattern for the other jobs.

The chunk-size and partial-body checks use a custom Node bridge. The production HTTP adapter was exercised with one 32-byte chunked upload. That does not cover the 26214400-byte boundary, abort, or parser rejection.

## Untested

- The installed phone build. Source tests are not device compatibility.
- A file written into a running computer container, including byte count, hash, and ownership. No disposable Docker daemon was available. The production daemon was not used.
- Host-computer transfers above 8 MiB. Those caps stay 8 MiB per file and 12 MiB per message.
- Production databases. The additive migrations were applied only to disposable databases.
- Moving every remaining background job onto the opaque dispatcher and leaving the runtime queue grants revoked.
- The shared disposable database still has retirement rows without a fingerprint registry, active ciphertext without one, and the old raw registry. Migrate refuses it. The messaging installation Postgres suite calls the installer there and does not run. Those rows were not deleted.


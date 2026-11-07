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
- Two organization owners were denied `uploadPolicy/set` through the route and through a direct `setUploadPolicy` call. The configured deployment-admin email was denied while `emailVerified` was false, including a direct service call, and allowed after it was true. The change wrote one `upload.policy.changed` event with previous bytes, new bytes, and a sequence number. Repeating the same value did not write another.
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

## Queue boundary, partly moved

Credential cleanup now calls `queue_api.create_credential_cleanup`. The Graphile payload is `{workItemId}`. The retired reference stays in `queue_private.credential_tombstone`, which the API login cannot read. The worker login claims it, skips it when it is still current, deletes it once, and a second claim does nothing. Stored dispatch errors are rewritten to `redacted`. A fixture rehearsal converts synthetic legacy rows, including a failed row, and does not delete a locked row or a live unresolved Graphile job.

The API login used for that test is a member of `rakazo_app`. After a revoke rehearsal it cannot select, update, delete, insert, truncate, call `add_job`, or `SET ROLE` to the worker or queue owner. The worker login can read the dispatch row. Those runtime grants are restored at the end of the test.

The rest of the publisher still writes entity ids through Graphile as the runtime login. Revoking those grants in a migration would stop the previous release, and this release, from enqueueing runs. `DATABASE_WORKER_URL` selects the worker pool when it is set. One bypass key still matches one runtime password, so the worker's tenant queries stay on `DATABASE_URL`. This is not tenant isolation and not a finished cutover.

## Untested

- The installed phone build. Source tests are not device compatibility.
- A file written into a running computer container, including byte count, hash, and ownership. No disposable Docker daemon was available. The production daemon was not used.
- Host-computer transfers above 8 MiB. Those caps stay 8 MiB per file and 12 MiB per message.
- Production databases. The additive migrations were applied only to the disposable database.
- Moving every remaining background job onto the opaque dispatcher and leaving the runtime queue grants revoked. Credential cleanup is the path that moved.

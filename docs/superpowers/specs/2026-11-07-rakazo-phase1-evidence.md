# Phase 1 evidence

Sanitized record for review. No connection strings, passwords, or production hosts. This is not a release. Alaric must re-review the new head. Phase 1 remains incomplete.

## Units

`MAX_UPLOAD_SIZE_MB` is a count of mebibytes, 1 through 25. The byte ceiling is 26214400. The environment parser rejects `26`, `26214400`, `0`, `-1`, and `1.5`. A stored policy is a byte count in steps of 1048576, at most 26214400. A stored value cannot raise an explicit environment ceiling. An invalid stored value fails closed to 1 byte with source `invalid`. The database check rejects any other non-null value.

The signed-in RPC body ceiling for a 26214400-byte file is 36001112 bytes. The limiter keeps that body, and the JSON parser and base64 decoder keep further copies. That is not a 25 MiB memory cap.

## Request shape

`phase1-foundation.postgres.test.ts` calls Hono `app.request`. Those are in-process application requests, not a listening socket.

`phase1-wire.postgres.test.ts` serves the same app on `127.0.0.1` port 0 and uses Node `http` and `net`.

## Tested

- In-process uploads of 26214399 and 26214400 bytes accepted, and 26214401 rejected with `upload_too_large`, on disposable Postgres.
- In-process chunked small upload accepted. Unfinished body returned `upload_incomplete`. A short Content-Length with a body over the ceiling returned 413.
- Listening-socket chunked uploads of 26214399 and 26214400 bytes accepted, and 26214401 rejected with `upload_too_large` and no artifact of that name. A destroyed chunked request and a chunk size of `ZZ` added no further artifact for that bot.
- Two organization owners were denied `uploadPolicy/set`. The configured deployment-admin email was denied while `emailVerified` was false and allowed after it was true. The change wrote one `upload.policy.changed` event with previous and new byte counts. Repeating the same value did not write another.
- Two concurrent requests for different byte counts produced two or three ordered events, and the stored value matched the last event. A trigger that rejects that audit insert returned a server error and left the stored value and event count unchanged.
- An explicit environment ceiling locked the stored value for the verified admin.
- A run-saved file of 3 MiB was rejected after the stored policy was 1 or 2 MiB, through the same finalizer the worker uses. No separate worker process was started.
- Supervisor HTTP, still in-process, accepted a 26214400-byte file body past the size gate and rejected 26214401 with `upload_too_large` before starting a computer. A caller `maxFileBytes` of 1 did not shrink the process ceiling, and a caller `maxFileBytes` of 99999999 did not raise it. No Docker daemon was available.
- Scripted chat completed. Shutdown requeue returned the run to queued. A stale fence did not.
- Runtime role `rakazo_phase1_runtime` is not a superuser and does not have BYPASSRLS. `describeRowSecurity` reported enforced. `artifacts` and `messages` have row security on. Another space could not read the artifact through the API or through a tenant query.
- A login that is not the runtime role, with usage on `graphile_worker` and no table grants, was denied select, update, delete, and insert on `graphile_worker._private_jobs`. The runtime role could still select that table.
- Local email emulator captured the welcome message. No paid model call.
- Mobile source tests covered the advertised byte limit, a loopback default, a private custom server, and sign-in plus `me` against that server.
- The check constraint rejected a stored value of 1 byte and accepted 1048576. The row was then set back to null.

## Queue boundary, not fixed

`graphile_worker` row security with `rakazo_app_queue` `USING (true)` is queue access for the shared runtime login. It is not tenant isolation. API enqueue and worker dispatch use one database URL. Payloads include run, thread, user, computer, routine, installation, and purchase ids, a push ticket id and token digest, and `messaging.credential-cleanup` includes the secret-store `ref` that is compared to ciphertext and passed to delete. Job rows can also hold the worker's recorded error text. A separate worker role, a privileged enqueue function, and an opaque cleanup record are not in this phase. The foreign-role denial above does not prove tenant isolation.

## Untested

- The installed phone build. Source tests are not device compatibility.
- A file written into a running computer container, including byte count, hash, and ownership. No disposable Docker daemon was available. The production daemon was not used.
- Host-computer transfers above 8 MiB. Those caps stay 8 MiB per file and 12 MiB per message.
- Production databases. The additive migrations were applied only to the disposable database.
- A second database login for the worker, and recovery of a job by that separate worker process.

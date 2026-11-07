# Phase 1 evidence

Sanitized record for review. No connection strings, passwords, or production hosts. This is not a release.

## Units

`MAX_UPLOAD_SIZE_MB` is a count of mebibytes, 1 through 25. The byte ceiling is 26214400. The environment parser rejects `26`, `26214400`, `0`, `-1`, and `1.5`. A stored policy is a byte count in steps of 1048576, at most 26214400. A stored value cannot raise an explicit environment ceiling. Request buffering uses that ceiling and is not allowed to grow past 26214400 bytes in this phase.

## Tested

- Direct HTTP uploads of 26214399 and 26214400 bytes accepted, and 26214401 rejected with `upload_too_large`, on disposable Postgres.
- Chunked small upload accepted. Unfinished body returned `upload_incomplete`. A short Content-Length with a body over the ceiling returned 413.
- Owner policy change wrote one audit event. Repeating it did not write another. A member was denied. An explicit environment ceiling locked the stored value.
- A run-saved file of 2 MiB was rejected after the stored policy was 1 MiB, through the same finalizer the worker uses.
- Supervisor HTTP accepted a 26214400-byte file body past the size gate and rejected 26214401 with `upload_too_large` before starting a computer. No Docker daemon was used.
- Scripted chat completed. Shutdown requeue returned the run to queued. A stale fence did not.
- Runtime role `rakazo_phase1_runtime` is not a superuser and does not have BYPASSRLS. `describeRowSecurity` reported enforced. `artifacts` and `messages` have row security on. Another space could not read the artifact through the API or through a tenant query. `graphile_worker._private_jobs` has row security on. Its runtime policy allows the queue role to see job rows, because those rows are queue metadata.
- Local email emulator captured the welcome message. No paid model call.
- Mobile source tests covered the advertised byte limit, a loopback default, a private custom server, and sign-in plus `me` against that server.

## Untested

- The installed phone build. Source tests are not device compatibility.
- A 25 MiB file written into a running computer container. The supervisor size gate was tested. The process has no database, so it does not apply a stored lower limit.
- Host-computer transfers above 8 MiB. Those caps stay 8 MiB per file and 12 MiB per message.
- Production databases. The additive migration was applied only to the disposable database.

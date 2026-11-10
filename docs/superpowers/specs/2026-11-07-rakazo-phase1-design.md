# Rakazo phase 1 design slice

This is the isolated foundation slice of the approved Rakazo workspace design. It is not a production release and not a claim that a running `edge` image matches this commit.

## Baseline

- Repository source: this checkout, commit `1f0dc6de46f2fa7a5b6d1bbbc434f518bdd1239d` (`fix(mobile): tolerate URL suffixes and rotated tokens in screen page check`).
- That commit is the same revision the design review read. Compose files still default image tags to `edge` (`ghcr.io/elie222/rakazo/app` and `ghcr.io/elie222/rakazo/computer`). Digests of any running deployment were not read. Do not treat this tree as production parity.
- Root license: Apache-2.0. Copyright line: `Copyright 2026 Rakazo contributors`. No `NOTICE` file in the tree. None was added.
- Package manager `pnpm@9.15.0`. App version `0.1.0`. API uses Hono `4.13.16` and `@orpc/server` `1.16.1`. Database package uses Prisma `7.10.1`. Root TypeScript `7.0.2`, Vitest `4.1.12`. Mobile Expo `57.0.32`, React Native `0.86.3`, app version `1.0.12`.

## What already exists

| Area | Where it lives | This slice |
| --- | --- | --- |
| Identity and spaces | Better Auth, `Space` and `SpaceMember`, first-account registration tests | Unchanged. Default enrollment behavior stays as implemented. |
| One bot and model adapter | Pi in API/worker; tests use `agentRuntime: "scripted"` and `sandboxProvider: "fake"` | Unchanged. No paid model call. |
| Durable runs | Fenced leases in the existing run engine | Unchanged. No second scheduler. |
| Private computer | Computer contract; image `USER 1000:1000`; supervisor refuses docker socket mounts | Unchanged. Existing denial test remains. |
| Event stream | Thread events and mobile `subscribeThread` | Unchanged. |
| Artifacts | `LocalArtifactStore` id paths, mode `0600`, optional encryption | Regression test for a traversal-like name. |
| Uploads | `MAX_UPLOAD_SIZE_MB`, advertised on `me` | Default when unset becomes 26214400. Count stays 4. |
| Email | `EMAIL_EMULATOR=true` captures mail on loopback outside production | Not re-run. No Postgres in this environment. |
| Approvals | Unset preference is Ask (`approvalModeFromPreference`) | Unchanged. |

## Upload policy

- Historical per-file default: 10 MiB, 10485760 bytes.
- This slice, when `MAX_UPLOAD_SIZE_MB` is unset or blank: 25 MiB, 26214400 bytes.
- An explicit integer, including `10`, still wins. Invalid values still fail startup.
- `MAX_ATTACHMENTS_PER_MESSAGE` remains 1 to 100, default 4.
- No separate chat message-total byte limit was found. The host-computer socket cap stays 12 MiB and was not retargeted.
- The HTTP limiter counts body bytes even when `Content-Length` is present and small. A declared length above the cap is rejected before the body is read.
- Decoded attachment bytes over the limit throw `AttachmentValidationError` with code `upload_too_large`. The procedure error stays HTTP 400 `BAD_REQUEST` and adds `data.code`.
- Signed-out RPC bodies are still discarded unread.
- There is no resumable chunk store. A cancelled or oversized body is not written as an artifact.
- There is no virus scanner and no quarantine directory.
- HTML preview may run script in a sandbox that does not share the app origin (`packages/core/src/artifact-sandbox.ts`). SVG is not an allowed attachment type.

## Upload policy precedence

`MAX_UPLOAD_SIZE_MB` counts mebibytes, from 1 through 25. The byte ceiling is 26,214,400. The value 26214400 is rejected as an environment setting, because that would mean 26214400 MiB. An explicit setting is the effective limit and the HTTP allocation ceiling. A stored byte count cannot raise it. When it is unset, a verified deployment admin (the existing `requireAdmin` check, not an organization owner or admin role) may store 1048576 through 26214400 bytes in steps of 1048576. Zero, negative, fractional, and larger values are rejected. An invalid stored value fails closed to one byte and source `invalid`. `me.maxUploadSizeBytes` is that byte count. The RPC body ceiling for a 25 MiB file is 36,001,112 bytes, and the request limiter plus the parser and decoder each hold copies.

The HTTP body buffer stays at the process ceiling until restart. The persisted value cannot raise it.

## File paths and the 12 MiB socket

- Supported at the effective limit, including 25 MiB when that is the ceiling: chat `artifacts/create` over HTTP, and the Docker supervisor `POST /computers/:id/files` HTTP route. Workspace transfer uses the process ceiling captured at supervisor startup. Publishing that file into a thread uses the stored policy. A `maxFileBytes` field on the supervisor request does not change either limit.
- Unsupported at 25 MiB, and left unchanged: the host-computer channel. Its message cap is 12 MiB (`HOST_COMPUTER_MAX_BYTES`) and its file cap is 8 MiB (`HOST_COMPUTER_MAX_FILE_BYTES`). The user-device websocket uses that message cap plus a small margin. Those caps also bound commands, so this slice does not raise them.
- There is no separate resumable chunk protocol. An unfinished HTTP body is rejected with `upload_incomplete` and is not stored.

## Schema

`deployment_settings.maxUploadSizeBytes` is a nullable integer of bytes, added by `20261130130000_upload_policy`. That name sorts after `20261130120000`, the latest migration already in this tree. A name of `20261107` would sort before later migrations this tree already contains, so Prisma would not apply it on a database that has those. `20261201` was ahead of both the work date and that sequence and was renamed before review. `20261130130100_upload_policy_check` adds a check: null, or a whole mebibyte from 1048576 through 26214400. It does not rewrite rows. Previous releases do not read the column. Leaving it after a code rollback is safe, and the check accepts the null those releases leave behind. Dropping it is safe only after this code is no longer running. Both migrations were applied only to a disposable local database.

## Mobile compatibility

Source of `apps/mobile` at this commit:

- Bundle id and Android package: `com.rakazo.app`. Expo slug `rakazo`. Version `1.0.12`, iOS `buildNumber` `1`, Android `versionCode` `10`.
- Default API base: `EXPO_PUBLIC_API_URL` or `http://127.0.0.1:3100`. Custom server is a stored base URL.
- Chat send uses `threads/send` and `threads/sendWithRoutines`. Events use `subscribeThread`. Uploads use `artifacts/create` and `attachmentMaxBytes(uploadConfig)`.
- When the server omits `maxUploadSizeBytes`, this source still falls back to 10 MiB. A server that advertises 26214400 is what a current client will enforce.
- Source tests do not show that an installed phone build is compatible. The installed build is unknown. No simulator or device was run. Store listings were not created.

To test a phone later, use the already installed app. Do not create a store listing. On the sign-in screen choose a custom server and enter the isolated API origin. Sign in, open a bot, and confirm a file at the advertised limit sends while one byte over does not. Record the installed version from the device settings screen. The source tree says version 1.0.12, iOS build number 1, Android version code 10, bundle `com.rakazo.app`. Those numbers are the source, not proof of the installed binary.

## Out of scope

Phase 2 coordination, a shared memory connector, action-bound approval receipts, an effect ledger, new routines, and budget accounting. OpenBot code and assets stay out. No production host, image, or credential is touched.

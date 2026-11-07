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

## Mobile compatibility

Source of `apps/mobile` at this commit:

- Bundle id and Android package: `com.rakazo.app`. Expo slug `rakazo`. Version `1.0.12`, iOS `buildNumber` `1`, Android `versionCode` `10`.
- Default API base: `EXPO_PUBLIC_API_URL` or `http://127.0.0.1:3100`. Custom server is a stored base URL.
- Chat send uses `threads/send` and `threads/sendWithRoutines`. Events use `subscribeThread`. Uploads use `artifacts/create` and `attachmentMaxBytes(uploadConfig)`.
- When the server omits `maxUploadSizeBytes`, this source still falls back to 10 MiB. A server that advertises 26214400 is what a current client will enforce.
- The installed phone build is unknown. Store listings were not created or changed. No simulator or device was run. A new app with new bundle ids is not required for this slice because the existing client contract still reaches the same procedures.

## Out of scope

Phase 2 coordination, a shared memory connector, action-bound approval receipts, an effect ledger, new routines, and budget accounting. OpenBot code and assets stay out. No production host, image, or credential is touched.

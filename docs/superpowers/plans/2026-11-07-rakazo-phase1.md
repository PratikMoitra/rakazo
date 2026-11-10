# Rakazo phase 1 foundation slice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the approved phase 1 boundary and ship one testable foundation slice: a 25 MiB per-file default, measured-byte rejection with a stable code, and a licensing inventory. Do not rewrite the platform.

**Architecture:** Keep the existing Rakazo API, worker, fenced run engine, Better Auth spaces, Expo client, and local artifact store. Change the unset upload default and the HTTP body counter. Leave identity, runs, computers, email, and approvals on their current modules.

**Tech Stack:** TypeScript, pnpm 9.15.0, Hono 4.13.16, oRPC 1.16.1, Prisma 7.10.1, Vitest 4.1.12, Expo 57.0.32. Versions were read from this tree's manifests, not guessed.

## Global Constraints

- Baseline commit is `1f0dc6de46f2fa7a5b6d1bbbc434f518bdd1239d` on `main`. That is the same commit the design review read. It is the branch source, not a claim that production `app:edge` or `computer:edge` images match it.
- Rakazo-only. No OpenBot source, assets, or numeric limits (not 100 MiB, not 250 MiB, not 10 files).
- Root `LICENSE` stays Apache-2.0, copyright 2026 Rakazo contributors. There is no upstream `NOTICE`. Do not add one.
- Modified files carry a phase-1 change notice. New files say they are not upstream Rakazo files.
- No merge to main, image push, public deploy, store submission, spend, reboot, live credentials, or production data.
- No database migration in this slice. No second scheduler. Approval default stays Ask.
- Disposable tests only. Model results in tests stay on the existing scripted runtime. No paid model calls.
- Per-file default is 26214400 bytes. `MAX_ATTACHMENTS_PER_MESSAGE` stays 4, ceiling 100.
- Clients with no advertised limit still use the historical 10485760-byte fallback.
- Host-computer protocol cap stays `HOST_COMPUTER_MAX_BYTES` = 12 MiB. It is not the chat attachment limit.

---

### Task 1: Audit and write this plan

**Files:**
- Create: `docs/superpowers/plans/2026-11-07-rakazo-phase1.md`
- Create: `docs/superpowers/specs/2026-11-07-rakazo-phase1-design.md`
- Create: `docs/compliance/2026-11-07-phase1-licensing.md`

- [x] Record baseline SHA, versions, what already exists, and the remainder.

### Task 2: 25 MiB default and measured bytes

**Files:**
- Modify: `packages/contracts/src/attachments.ts`
- Modify: `packages/core/src/attachments.ts`
- Modify: `packages/core/src/attachments.test.ts`
- Modify: `apps/api/src/env.test.ts`
- Modify: `apps/api/src/request-body-limit.ts`
- Modify: `apps/api/src/request-body-limit.test.ts`
- Modify: `apps/api/src/artifacts.ts`
- Modify: `apps/api/src/artifacts.test.ts`
- Modify: `apps/api/src/routes/content.ts`
- Modify: `apps/api/src/routes/threads.ts`
- Create: `apps/api/src/attachment-error.ts`
- Create: `apps/api/src/attachment-error.test.ts`
- Modify: compose fallbacks, `.env.example`, `docs/self-host-storage.md`

**Interfaces:**
- Produces: `DEFAULT_UPLOAD_MAX_BYTES = 26214400`, `UPLOAD_TOO_LARGE_CODE = "upload_too_large"`
- Produces: `assertUploadByteLength(actual, maxBytes)` throws `AttachmentValidationError` with that code
- Produces: `uploadSizeFromEnv({})` returns `26214400`
- Produces: `orpcAttachmentError(error)` returns `ORPCError` `BAD_REQUEST` with `data.code`

- [x] Decoder accepts 26214399 and 26214400 and rejects 26214401 with `upload_too_large`
- [x] HTTP body limiter counts bytes when `Content-Length` is smaller than the body
- [x] Unset env and compose fallback use 25 MiB; count stays 4

### Task 3: Path and license record

**Files:**
- Modify: `packages/adapters/src/artifacts.test.ts`
- Create: `docs/compliance/2026-11-07-phase1-licensing.md`

- [x] A display name of `../../etc/passwd` is stored under the space id
- [x] License inventory lists gaps and does not treat unknown rights as clearance

## Remainder (not done in this slice)

- Persisted owner/admin upload setting and an audit row. Today the control is `MAX_UPLOAD_SIZE_MB`, validated at process start. There is no in-app mutation route, so this slice does not write a fake audit event on every boot.
- Disposable Postgres proof of chat, restart recovery, cross-space denial, and the local email emulator. Those modules exist and have their own tests. This environment has no Postgres, so they were not re-run.
- Phone on a device or simulator. Source compatibility only.
- Resumable chunk protocol. Intake is one JSON body. Unfinished HTTP bodies are cancelled and are not stored.
- Virus scanning. Absent.
- Phase 2 coordination, shared memory connector, action-bound approval receipts, effect ledger, routines, and budget accounting.
- Any store listing, new bundle id, or production image.

## Rollback

No migration file. Reverting the commit restores the 10 MiB unset default. A deployment that already set `MAX_UPLOAD_SIZE_MB` is unchanged. This branch was not deployed.

# Phase 1 licensing record

This note is a workspace compliance record for the isolated phase 1 slice. It is not an upstream Rakazo `NOTICE` file. The repository root has no `NOTICE`, and this slice does not add one. The root `LICENSE` is unchanged Apache-2.0 with `Copyright 2026 Rakazo contributors`.

## Boundary

- Implementation stays inside this Rakazo tree.
- No current OpenBot code, assets, or branding was read into or copied into this branch.
- Unknown rights are gaps for legal review. They are not clearance.
- Nothing here is a store submission, a public release, or permission to republish the existing phone app under new branding.

## Modified files

Each file this slice changed carries a one-line notice that the change belongs to this phase 1 workspace slice and is not an upstream release. New files say they are phase 1 additions. The Apache-2.0 text stays in `LICENSE`.

## Workspace packages

The root package and the app and library packages that declare a license field use `"license": "Apache-2.0"`. That is the project's own declaration, not a review of every file inside those packages. The private Expo modules noted below omit the field.

## Dependency inventory

Third-party licenses were read from installed `package.json` files after `pnpm install --frozen-lockfile` on this commit's lockfile (`lockfileVersion` 9.0). 2187 package versions were counted. The committed summary keeps the counts and the non-permissive or missing entries. The full name list is not committed, because it was generated bulk rather than source. A populated field is attribution data, not a legal opinion, and it does not permit resale.

Items a reviewer should read before any distribution, because the declared license is copyleft, functional-source, missing, or unusual:

- `@img/sharp-libvips-linux-*` 1.3.4 declares LGPL-3.0-or-later.
- `@sentry/cli` 2.58.4 and `sentry` 0.45.0 declare Functional Source License variants.
- `elkjs` 0.11.1 declares EPL-2.0.
- `node-forge` 1.4.0 declares BSD-3-Clause OR GPL-2.0.
- `khroma` 2.1.0 and `novita-sandbox` 2.1.2 have no license field.
- `react-native-fit-image` 1.5.5 declares Beerware. `truncate-utf8-bytes` 1.0.2 declares WTFPL.

The six private Expo modules under `apps/mobile/modules` omit a `license` field. They are first-party files in this Apache-2.0 tree, not a third-party grant. The missing field is still a packaging gap for a future app bundle.

No dependency was upgraded for this inventory.

## Assets

| Path | What the tree says | Rights status |
| --- | --- | --- |
| `packages/ui-tokens/assets/Rakazo.icon` and exported PNG/ICNS marks | Shared Rakazo icon source. `packages/ui-tokens/assets/README.md` describes the orange foreground and exports. | Trademark and copyright not verified here. A future publishable app needs its own branding and icons unless those rights are verified. |
| `apps/mobile/assets/icon.png`, adaptive, monochrome, splash, notification, favicon | Exports of that icon, per the same README. | Same gap. Not cleared for a new store app. |
| `apps/mobile/assets/material-icons/*.xml` | Three vector paths used by the create chooser. No license header in the files. The shapes match common Material icon paths. | License text is not in the repo. Not clearance. |
| `apps/mobile/assets/sounds/*.m4a` | Call cues referenced from `apps/mobile/lib/call-sounds.ts`. No provenance note in that file. | Unknown. Not clearance. |
| `apps/www/public/fonts/aeonik-medium.woff` | Marketing site font file. No license file beside it. | Unknown. Do not copy it into a new app. Marketing pages are outside the product vendor-name rule, and that does not clear the font. |

## Connectors

`docs/integrations.md` describes Treg and Executor as optional token gateways, plus MCP, OpenAPI, and catalog connectors. This slice does not add a connector and does not audit resale terms. Treg's provider terms are an open legal-review item before any resale or redistribution of a connected offering. Credentials stay in the existing encrypted connector path and are not sent to a model by this change.

## A future publishable app

If a new client is published later, it needs its own bundle and package ids, its own icons, accessible copies of the Apache-2.0 text and any third-party notices that apply, and a completed review of connector terms. This slice does not create that app, a store listing, or a signing setup.

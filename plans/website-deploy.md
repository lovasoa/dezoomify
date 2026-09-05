# Plan: One Pages project: legacy site at /, new app at /beta

Status: in progress (2026-09-05).

## Problem

The Cloudflare Pages project deploys `master` (the legacy dezoomify-web
app) at production and the `ng` branch (the rewrite) as a preview that
publicly serves every committed file, including `migration-sources/`.
Because the git integration serves committed files only, the repository
also carries generated website artifacts (TS→JS mirrors, wasm-bindgen
glue, generated help pages) that must be regenerated on every change.

## Decision (owner, 2026-09-05)

One Cloudflare Pages project and one build process. The repository gains
a `legacy/` folder: the legacy site vendored from `master` with its git
history (git subtree), copied verbatim to `dist/`. The new app builds to
`dist/beta`. A GitHub Actions workflow (already landed: build → deploy →
verify) uploads `dist/` to a new Direct Upload Pages project with
wrangler. The old git-integrated project keeps serving production until
the cutover, so nothing breaks while the new version is iterated on:
users reach the new app at `/beta` on the same domain, and the legacy
app's popup invites them to try it and report issues on GitHub.

Kept committed by decision: `packages/protocol-ts/src/generated.ts` and
`generated/*.json` (versioned contract/input artifacts, drift-checked,
never deployed).

Constraints:

- The legacy site must stay byte-identical in behavior: `legacy/` is
  copied verbatim; its `functions/proxy.js` (GET `/proxy?url=…`) keeps
  serving the legacy app's proxy route.
- The new app keeps calling the same-origin `/api/proxy`; absolute
  paths work unchanged under `/beta`.
- One-way door, accepted: the old git-integrated project is eventually
  deleted and replaced by the wrangler-deployed project; the custom
  domain moves at cutover.

## Phases

### WD1 (done): Site assembly pipeline

`scripts/build-site.mjs`: single runner-agnostic builder. `cargo xtask
build web` calls it.

### WD2 (done): E2E serves the deployed tree

Playwright builds via `scripts/build-site.mjs` and serves `dist/`
(amended to `/beta/` by WD5).

### WD3 (done): Deploy workflow

`website-deploy.yml`: pinned toolchain, rust-cache, wasm-bindgen-cli at
the Cargo.lock version, build, `wrangler pages deploy`, live
verification. Deploys are skipped (warning) while the Cloudflare secrets
are absent.

### WD4: Vendor the legacy site as `legacy/`

`git subtree add --prefix=legacy origin/master` (history preserved; the
prose-style gate skips the verbatim tree, like `migration-sources/`).
The legacy app's sources live on from here: legacy fixes land in
`legacy/` on `ng` (or upstream on `master`, then `git subtree pull`).

### WD5: Single-site layout

`dist/` = the legacy site (verbatim copy of the servable `legacy/`
files: pages, `zoommanager.js`, `dezoomers/`, assets, `404.html`) plus
the new app under `dist/beta/`. The pure proxy modules move out of
`functions/` to `src/server/` (they were phantom routes anyway), making
room for the legacy `functions/proxy.js` route via a one-line re-export
shim; `_routes.json` includes `/proxy` and `/api/proxy`. E2E runs
against `/beta/`. Verified locally with `wrangler pages dev`.

### WD6: New Pages project (owner action)

Owner creates one Direct Upload project (`dezoomify-ng`, production
branch `ng`) and sets the `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` GitHub secrets; the workflow then deploys
legacy + beta to `dezoomify-ng.pages.dev` on every `ng` push and
verifies it live. The owner also disables non-production preview
deployments on the OLD project, so `ng.dezoomify.pages.dev` stops
mirroring repository files (this unblocks WD7). Cutover (later,
explicitly decided): move the custom domain to the new project, then
delete the old project.

### WD7: Untrack the generated artifacts

`git rm` the mirrors, wasm glue, and generated `help/`; extend
`.gitignore`; `cargo xtask test web` and the root `pnpm test` regenerate
mirrors + help before running node tests; `cargo xtask check` drops the
mirror drift gate; the help freshness test becomes a determinism check.

### WD8: Beta invitation popup + documentation

Replace the legacy popup's stale content with an invitation to try
`/beta` and report issues on GitHub (owner reviews the wording). Docs:
`docs/development.md` (build/deploy contract), `docs/user/README.md`,
`AGENTS.md` current state. Plan file removed on completion.

## Risks

- Cross-directory imports from `functions/` (`../../src/server/*`,
  `../legacy/functions/proxy.js`): validated locally with
  `wrangler pages dev` before landing; fallback is assembling the
  functions tree at build time.
- Legacy divergence: `legacy/` is the deployed copy from WD4 on;
  `master` is frozen for deployment purposes.
- The `dezoomify.pages.dev` subdomain stays with the old project until
  cutover; the new project's canonical address is its custom domain
  after cutover.

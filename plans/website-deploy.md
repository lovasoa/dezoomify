# Plan: One Pages project: legacy site at /, new app at /beta

Status: complete (2026-09-05). Final architecture, restated (owner,
2026-09-05): the original `dezoomify` project is the only Pages project;
GitHub Actions builds `dist/` and uploads it with wrangler; `master` is
the single branch holding `legacy/` and the new app; automatic git
deployments on the project are disabled so the workflow is the only
publisher; `dezoomify.ophir.dev` serves the legacy site at `/` and the
new app at `/beta`. The intermediate `dezoomify-ng` project was deleted.

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

### WD4 (done): Vendor the legacy site as `legacy/`

`git subtree add --prefix=legacy origin/master` (history preserved; the
prose-style gate skips the verbatim tree, like `migration-sources/`).
The legacy app's sources live on from here: legacy fixes land in
`legacy/` on `ng` (or upstream on `master`, then `git subtree pull`).

### WD5 (done): Single-site layout

`dist/` = the legacy site (verbatim copy of the servable `legacy/`
files: pages, `zoommanager.js`, `dezoomers/`, assets, `404.html`) plus
the new app under `dist/beta/`. The pure proxy modules move out of
`functions/` to `src/server/` (they were phantom routes anyway), making
room for the legacy `functions/proxy.js` route via a one-line re-export
shim; `_routes.json` includes `/proxy` and `/api/proxy`. E2E runs
against `/beta/`. Verified locally with `wrangler pages dev`.

### WD6 (done): The Pages project

The original `dezoomify` project (production branch `master`) is the
deploy target. Its automatic git deployments are disabled via the API
(`deployments_enabled: false`, `production_deployments_enabled: false`,
`preview_deployment_setting: "none"`), which also unlocks wrangler
uploads for a previously git-integrated project; the
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` GitHub secrets are set.
A wrangler upload to a throwaway branch was verified end to end (legacy,
beta, both proxies, no repository files) before `master` switched over.
The temporary `dezoomify-ng` project created during the transition was
deleted.

### WD7 (done): Untrack the generated artifacts

`git rm` the mirrors, wasm glue, and generated `help/`; extend
`.gitignore`; `cargo xtask test web` and the root `pnpm test` regenerate
mirrors + help before running node tests; `cargo xtask check` drops the
mirror drift gate; the help freshness test becomes a determinism check.

### WD8 (done): Beta invitation popup + documentation; cutover pending

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

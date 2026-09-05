# Plan: GitHub Actions builds the website; wrangler deploys to Cloudflare Pages

Status: in progress (2026-09-05).

## Problem

The Cloudflare Pages project deploys the `ng` branch through the Git
integration with no build step: output directory = repository root, so
every committed file is publicly served (`/README.md`, `/crates/...`,
even `/migration-sources/...` return 200 on the branch preview). Because
Pages serves committed files only, the repository also carries generated
website artifacts:

- the ten TS→JS mirrors (`src/*.js`, `packages/shared-ui/src/*.js`,
  `packages/browser-runtime/src/*.js`) from `scripts/sync-web-js.mjs`,
- the wasm-bindgen glue `wasm/dezoomify-wasm.js` +
  `wasm/dezoomify-wasm_bg.wasm` (~4.4 MB),
- the nine `help/*.html` pages from `scripts/build-help.mjs`.

## Decision (owner, 2026-09-05)

GitHub Actions compiles and generates everything at deploy time and
uploads the site to Cloudflare Pages with `wrangler pages deploy`
(Direct Upload); the repository commits no generated website artifacts.
Rationale over a Cloudflare build command: cargo/wasm builds get Actions
caching (`Swatinem/rust-cache`), deploys can be gated on the existing
deterministic CI, and the push-heavy `ng` workflow does not burn
uncached Pages build minutes. `scripts/build-site.mjs` is the single
runner-agnostic builder: JS mirrors, help pages, wasm glue (release,
`wasm32-unknown-unknown`), and the `dist/` tree (pages, walked browser
import graph, styles, wasm glue, `_routes.json` limiting Function
invocation to `/api/proxy`).

Kept committed by decision: `packages/protocol-ts/src/generated.ts` and
`generated/*.json` (versioned contract/input artifacts, drift-checked,
never deployed).

One-way door, accepted: a Git-integrated Pages project can never switch
to Direct Upload. The old project is deleted and recreated as a
wrangler-deployed project (the `dezoomify` subdomain is reclaimed by
recreating with the same name; the custom domain is moved to the new
project). `functions/` stays at the repository root; wrangler compiles
it on `pages deploy`; only `/api/proxy` is a route.

Secrets (GitHub, set by the owner): `CLOUDFLARE_API_TOKEN` (scoped
Account → Pages → Edit) and `CLOUDFLARE_ACCOUNT_ID`. The workflow fails
closed when they are absent.

## Phases

### WD1: Site assembly pipeline (additive)

`scripts/build-site.mjs` (mirrors + help + glue + dist/ assembly).
`cargo xtask build web` calls it. Nothing is untracked yet, so every
deploy and CI lane stays green.

Acceptance: `cargo xtask build web` produces a complete `dist/` with
`_routes.json`; `cargo xtask test web` passes.

### WD2: E2E serves the deployed tree

The Playwright E2E setup builds via `scripts/build-site.mjs` and serves
`dist/` (was: the repository root), so E2E exercises exactly what the
deploy workflow uploads.

Acceptance: `cargo xtask test web` (E2E included) passes against `dist/`.

### WD3: Deploy workflow

`website-deploy.yml` becomes build → deploy → verify: pinned toolchain +
`Swatinem/rust-cache`, `wasm-bindgen-cli` at the exact `Cargo.lock`
version via `taiki-e/install-action`, `node scripts/build-site.mjs`,
`wrangler pages deploy dist --branch <ref>` (branch preview alias stays
`ng.dezoomify.pages.dev`), then the existing live verification loop plus
new exposure checks (repository files must not be served).

Acceptance: workflow deploys and verification passes on the branch
preview.

### WD4: Pages project migration (owner action, between pushes)

Owner deletes the Git-integrated project and recreates `dezoomify` as a
Direct Upload project (`wrangler pages project create dezoomify
--production-branch main`), moves the custom domain, and sets the two
GitHub secrets. Must happen before WD5: untracking before the migration
would leave the old project deploying a broken site (it serves committed
files only), and the new workflow cannot deploy until the project and
secrets exist.

### WD5: Untrack the generated artifacts

`git rm` the mirrors, wasm glue, and `help/`; extend `.gitignore`;
`cargo xtask test web` and the root `pnpm test` regenerate mirrors + help
before running node tests; `cargo xtask check` drops the now-meaningless
mirror drift gate; the help freshness test becomes a determinism check.

Acceptance: fresh checkout passes `cargo xtask ci local` (web lane
generates everything it needs); `git status` stays clean after a build.

### WD6: Documentation

`docs/development.md` (build/deploy contract), `docs/user/README.md`
(help generation), `AGENTS.md` current-state line, this plan's status.
On completion the plan file is removed per repository convention.

## Risks

- The `dezoomify.pages.dev` subdomain is released while the old project
  is deleted and the new one created; the custom domain is canonical, so
  the window only affects the pages.dev alias.
- Wrangler's default `_routes.json` generation: the build provides an
  explicit one in `dist/`; if wrangler ever overrode it with `/*`, the
  site still works (functions fall through to static assets), just with
  Function invocations on every request.
- `wasm-bindgen-cli` version drift vs `Cargo.lock`: the workflow derives
  the version from `Cargo.lock`, so the two cannot diverge silently.

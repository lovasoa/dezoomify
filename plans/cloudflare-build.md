# Plan: Cloudflare builds the site (no committed generated artifacts)

Status: in progress (2026-09-05).

## Problem

The Cloudflare Pages project deploys the `ng` branch with no build step:
output directory = repository root, so every committed file is publicly
served (`/README.md`, `/crates/...`, and even `/migration-sources/...`
return 200 on the branch preview). Because Pages serves committed files
only, the repository also carries generated website artifacts:

- the ten TS→JS mirrors (`src/*.js`, `packages/shared-ui/src/*.js`,
  `packages/browser-runtime/src/*.js`) from `scripts/sync-web-js.mjs`,
- the wasm-bindgen glue `wasm/dezoomify-wasm.js` +
  `wasm/dezoomify-wasm_bg.wasm` (~4.4 MB),
- the nine `help/*.html` pages from `scripts/build-help.mjs`.

## Decision (owner, 2026-09-05)

Cloudflare Pages compiles and generates everything at deploy time; the
repository commits no generated website artifacts. The Pages project gets:

- Build command: `bash scripts/cf-build.sh`
- Build output directory: `dist`
- Environment: `SKIP_DEPENDENCY_INSTALL = 1` (the build needs no npm
  packages; Node 22 comes from `.node-version`)

`scripts/cf-build.sh` bootstraps the pinned Rust toolchain
(`rust-toolchain.toml`), installs `wasm-bindgen-cli` at the exact version
pinned by `Cargo.lock`, and runs `node scripts/build-site.mjs`, which:

1. regenerates the browser JS mirrors from TypeScript sources,
2. regenerates `help/` from `docs/user/`,
3. builds the wasm adapter (release, `wasm32-unknown-unknown`) and its
   glue,
4. assembles `dist/` — the exact served tree: `index.html`, legal pages,
   favicons, the walked browser import graph, styles, `wasm/` glue,
   `help/`, and `_routes.json` limiting Function invocation to
   `/api/proxy`.

`functions/` stays at the repository root (Pages compiles it independently
of the output directory); only `/api/proxy` is a route. Kept committed by
decision: `packages/protocol-ts/src/generated.ts` and `generated/*.json`
(versioned contract/input artifacts, drift-checked, never deployed).

## Phases

### CB1 — Site assembly pipeline (additive)

`scripts/build-site.mjs` (single builder: mirrors + help + glue + dist
assembly) and `scripts/cf-build.sh` (toolchain bootstrap). `cargo xtask
build web` assembles `dist/`. Nothing is untracked yet, so every deploy
and CI lane stays green.

Acceptance: `cargo xtask build web` produces a complete `dist/` with
`_routes.json`; `cargo xtask test web` passes.

### CB2 — E2E serves the deployed tree

The Playwright E2E setup builds via `scripts/build-site.mjs` and serves
`dist/` (was: the repository root), so E2E exercises exactly what
Cloudflare deploys.

Acceptance: `cargo xtask test web` (E2E included) passes against `dist/`.

### CB3 — Dashboard flip (owner action, between pushes)

Owner sets build command / output directory / `SKIP_DEPENDENCY_INSTALL` in
the Cloudflare dashboard. The branch preview must then serve the site from
`dist/` and stop serving repository files. Only after this is verified may
CB4 land (untracking before the flip would deploy a broken site, because
the old settings serve committed files only).

### CB4 — Untrack the generated artifacts

`git rm` the mirrors, wasm glue, and `help/`; extend `.gitignore`;
`cargo xtask test web` and the root `pnpm test` regenerate mirrors + help
before running node tests; `cargo xtask check` drops the now-meaningless
mirror drift gate; the help freshness test becomes a determinism check.

Acceptance: fresh checkout passes `cargo xtask ci local` (web lane
generates everything it needs); `git status` stays clean after a build.

### CB5 — Deploy verification hardening

`website-deploy.yml` additionally asserts the deployment does not serve
repository content (`/README.md`, `/plans/`, `/crates/` must not return
repository bytes; SPA fallback makes them 200 text/html, so the checks
match on content, not status).

### CB6 — Documentation

`docs/development.md` (build/deploy contract), `docs/user/README.md`
(help generation), `AGENTS.md` current-state line, this plan's status.

## Risks

- Cold wasm build on every deploy (no cargo cache in Pages builds):
  minutes of build time per deploy; acceptable at current push cadence.
- Pages must keep detecting `functions/` at the repo root with a non-root
  output directory; the deploy verification (proxy 403 gate) catches a
  regression, and bundling `functions/` into `dist/_worker.js` is the
  recorded fallback.
- `wasm-bindgen-cli` version drift vs `Cargo.lock`: `cf-build.sh` derives
  the version from `Cargo.lock`, so the two cannot diverge silently.

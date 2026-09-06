# Legacy retirement (day-of-switch plan)

Status: NOT YET EXECUTED — doc-only. Legacy stays at `/` for now.
Do not execute this plan until its preconditions hold and the owner
explicitly orders the switch. When executed, it lands as ONE atomic
commit that ends with zero remnant of the legacy+beta state: the new
app serves `/` directly, there is no `legacy/` tree, no `/proxy`
route, and no `/beta` prefix anywhere in code, config, docs, or the
deployed tree.

Grounding (read before executing): `scripts/build-site.mjs`
(`copyLegacy()` + `copy(rel, BETA)` — there is no `copyBeta()`; the
beta tree is assembled by copying entries, assets, the browser module
graph, and wasm glue under the `BETA = "beta"` prefix),
`.github/workflows/website-deploy.yml` (build via
`node scripts/build-site.mjs`, `wrangler pages deploy dist`, verify
block gating legacy at `/` plus beta at `/beta`), and `AGENTS.md`
deploy rows (legacy site at `/`, new app at `/beta`, nothing
generated committed, workflow never serves repository files).

## Preconditions

1. Owner explicitly orders the switch (day-of-switch decision).
2. The new app at `/beta` is accepted as the full replacement: parity,
   help, wasm worker, and `/api/proxy` metadata relay are green on
   production.
3. No pending legacy fixes: no open legacy bugs, no in-flight legacy
   content changes worth preserving beyond git history.
4. `cargo xtask check`, bare `cargo xtask test`, `cargo xtask test all`,
   and `cargo xtask ci local` are green on `master` before the switch
   commit.
5. Cloudflare Pages project (`dezoomify`) and deploy secrets
   (`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`) are in their
   steady state: the `website-deploy` workflow is the only publisher
   (automatic git deployments stay disabled), so the switch commit
   deploys through the normal pipeline with its verify gates.
6. The switch is a single atomic commit on `master` (no stacked or
   partial landings). Rollback is `git revert` of that commit (see
   below).

## Exact delete list

Everything in this table goes in the one switch commit. Paths are
repository-relative.

| Path | What it is | Disposition |
|---|---|---|
| `legacy/` | Entire vendored legacy site: `index.html`, `404.html`, `zoommanager.js`, `browser-init.js` (incl. beta invitation), `dezoomers/`, `style.css`, `favicon.png`, `icon.svg`, `error.svg`, `cover.png`, `LICENSE`, `README.md`, `AGENTS.md`, `.gitignore`, `legacy/.github/workflows/node.js.yml` (+ `FUNDING.yml`, `ISSUE_TEMPLATE/`), `legacy/.github/` remainder | Delete recursively |
| `legacy/functions/proxy.js` (+ `legacy/functions/package.json`) | Canonical `/proxy` handler (`MAX_REDIRECTS`, CORS, `GET /proxy?url=…`; bound via the root shim, adapted by `node-app/proxy.js`) | Delete (goes with `legacy/`; listed explicitly because `/proxy` depends on it — `copyLegacy()` today throws if it is missing) |
| `functions/proxy.js` | Root 9-line shim re-exporting `onRequestGet` / `onRequestHead` / `onRequestOptions` from `../legacy/functions/proxy.js` | Delete file |
| `legacy/tests/` | Legacy test tree: `dezoomers.spec.js`, `fixture-server.js`, `fixtures/` (incl. remote `historischarchief…` / `www.ngv.vic.gov.au` fixtures), `images/`, `certs/`, `proxy-function.spec.js`, `live-compat.spec.js`, `live-playwright.config.js`, `playwright.config.js`, `node-cli-smoke.js`, `package.json`, `package-lock.json` | Delete (goes with `legacy/`; do not migrate — deterministic coverage for the new app lives in `testdata/scenarios` + `cargo xtask test` lanes) |
| `legacy/node-app/` | `dezoomify-node.js`, `proxy.js` (adapts `functions/proxy.js` to a local Node HTTP server), `package.json`, `package-lock.json`, `README.md` | Delete IF legacy-only. Before deleting, prove it: `rg -n "node-app|dezoomify-node" --glob '!legacy/**'` and `rg -n "legacy/functions/proxy|functions/proxy\.js" --glob '!legacy/**' --glob '!functions/proxy.js'` must return nothing except this plan. If any non-legacy consumer exists, extract it first; the switch commit itself must not leave a dangling import |
| `/proxy` route | `ROUTES.include` entry in `scripts/build-site.mjs`, `functions/proxy.js` binding, `website-deploy.yml` `legacy_proxy` gate (expects HTTP 400 for missing `url`) | Delete all three; after the switch `/proxy` is not a Function route and must not appear in `_routes.json` |
| `beta` prefix | `BETA = "beta"` const + every `copy(rel, BETA)` destination (`dist/beta/` pages, assets, `src/main.js`, `src/worker.js`, `wasm/`, `help/`), `HTML_ENTRIES` beta destination, `dist/beta/` sanity keys, workflow `/beta/` verify URLs, e2e `ADDR + "/beta/"` callers, docs `/beta` references | Delete the prefix: the new app assembles directly into `dist/` root; no `dist/beta/` directory, redirect, alias, or compat path remains |

## `scripts/build-site.mjs` changes

- Delete `LEGACY_EXCLUDE`, `copyLegacy()`, and `copyTree()` if it has
  no remaining caller. Delete the `BETA` const and the `prefix`
  parameter on `copy()`.
- Copy the new-app tree to `dist/` root: `HTML_ENTRIES` + generated
  `help/` pages, `localAssetsOf()` assets, `browserGraph(["src/main.js",
  "src/worker.js"])` modules, and `wasm/dezoomify-wasm_bg.wasm`
  (fetched by the glue at runtime, not an import specifier).
- Set `ROUTES = { version: 1, include: ["/api/proxy"], exclude: [] }`
  and keep writing it to `dist/_routes.json`. No `/proxy` entry.
- Rewrite the header comment (today: legacy verbatim at `/`, new app
  at `/beta`, `legacy/functions/proxy.js` bound at `/proxy` by the
  shim) to: single app at `/`, `functions/api/proxy.ts` owns
  `/api/proxy`, nothing generated committed, `dist/` never serves
  repository files.
- Rewrite the step-4 comment and the sanity list: required keys become
  root paths — `index.html`, `src/main.js`, `src/worker.js`,
  `wasm/dezoomify-wasm.js`, `wasm/dezoomify-wasm_bg.wasm`,
  `help/index.html`, `_routes.json` — plus whatever root contract the
  new app needs (`privacy.html`, `terms.html`, `404.html` if still
  served). Remove `zoommanager.js`, `dezoomers/zoomify.js`,
  `beta/index.html`, `beta/src/*`, `beta/wasm/*`, `beta/help/*`.
- Update the build log line (today: `legacy at /, new app at /beta`)
  to the single-app layout.

## Workflow changes (`.github/workflows/website-deploy.yml`)

- Header comment: single build (`node scripts/build-site.mjs`),
  single app at `/`, `wrangler pages deploy dist`, workflow is the
  only publisher. Remove the legacy-at-`/` / app-at-`/beta` sentence.
- Build, credentials, and `wrangler pages deploy dist` steps are
  unchanged (same script, same `dist/` upload, same secrets
  fail-closed behavior).
- Rewrite the verify block to the single-app contract (keep the
  browser user agent, the 24×30s retry loop, and the content — not
  status — gates):
  - `/` serves the new app: HTTP 200 plus `dz-url-input` or `id="app"`
    plus `src/main.js`; legacy markers (`rendering-canvas`,
    `zoommanager.js`) must NOT appear.
  - App assets at root: `src/main.js`, `src/discovery.js` (or its
    successor graph entry), `wasm/dezoomify-wasm.js` as
    `application/javascript`, `wasm/dezoomify-wasm_bg.wasm` as
    `application/wasm` (same MIME strictness as today — a 200
    `text/html` fallback masks a missing asset and wedges the worker).
  - Help at `/help/` (not `/beta/help/`): HTTP 200 plus
    `dz-help-topics`. Keep the stale-content negative gate
    (today: `14 of 28` must not appear), retargeted at `/`.
  - `/api/proxy` gate retained (blocked loopback target answers 403
    itself). `/proxy` gate inverted: today `legacy_proxy` must be 400
    (route live); after the switch `/proxy` must NOT be a Function —
    assert it is not 400-from-the-handler (expect the static 404) and
    remove the `legacy_proxy` 400 success condition.
  - `/beta/*` must 404 (no prefix remnant, no redirect alias).
  - No-repository-files gates retained (`/README.md` content probe,
    `crates/*/Cargo.toml` content-type probe).
- `SITE_HOST`, concurrency, and timeouts are unchanged.

## `_routes.json` + docs updates

- `_routes.json` (generated by `build-site.mjs`, not hand-edited):
  after the switch the emitted file is `{ "version": 1, "include":
  ["/api/proxy"], "exclude": [] }`. Every other path is static-only.
- `AGENTS.md`: Generated-artifacts row becomes single-app (build via
  `scripts/build-site.mjs`, new app at `/`, never serves repository
  files); Git row drops `holds both the legacy site (legacy/) and`
  (master holds the new app); keep the vocabulary and protocol rows.
- `docs/development.md` Website deployment contract: step 1 becomes
  `dist/` = new app at `/` + `_routes.json` limited to `/api/proxy`
  (`functions/api/proxy.ts`); step 3 becomes verify single app +
  `/api/proxy` + wasm MIME + help + no-repository-files; dev-servers
  table drops `at /beta` (shared UI runs inside the app at `/`).
- `functions/api/proxy.ts` header comment: remove the
  `(legacy/functions/proxy.js owns the /proxy route)` clause.
- `crates/xtask/src/browser.rs` `dev_ui` comment (shared UI at
  `/beta`): retarget to `/`. Any other `at /beta` code comment goes
  with it.
- `crates/fixture-server/tests/webapp-e2e/webapp.spec.js` and
  `liveweb.spec.js`: `ADDR + "/beta/"` becomes `ADDR + "/"` (all
  occurrences).
- `plans/README.md`: extend the Completed-plans entry — it is the ONE
  allowed archive note naming the retired layout (legacy at `/`, new
  app at `/beta`, removal date + switch-commit SHA). No other
  `legacy`/`beta-prefix` mention remains (see Acceptance).
- `docs/user/README.md`, `docs/architecture.md`,
  `docs/browser-runtime.md`, `docs/testing.md`: audit for
  `legacy/`/`/beta`/`/proxy`-as-legacy-route references in the same
  commit; update each hit or prove it names an unrelated concept.
- Pre-switch audit for false friends: `rg -n -i "legacy"` today hits
  non-site concepts (`legacy-web.json` transcripts,
  `legacy?format=xml` / `legacy_files` / `legacy-embed.html` fixture
  names, `legacy base64` / `legacy suffix` code comments,
  `legacy_transcript` in `parities`). The switch commit renames or
  justifies every hit so the acceptance gate below is literally true;
  anything renamed keeps its behavioral contract (goldens move with
  their scenarios, code comments use the format name, not "legacy").

## Verification (after the switch commit, before declaring done)

1. `node scripts/build-site.mjs` (full build; `--no-wasm` only for
   lanes that never load the worker) succeeds from a clean tree.
2. `dist/` layout: new-app `index.html`, `src/main.js`,
   `src/worker.js`, `wasm/dezoomify-wasm.js`,
   `wasm/dezoomify-wasm_bg.wasm`, `help/index.html` at ROOT;
   `dist/_routes.json` includes only `/api/proxy`; NO `dist/beta/`,
   NO `zoommanager.js`, NO `dezoomers/`, NO legacy `index.html`
   markers.
3. Help: `/help/` serves generated pages (`dz-help-topics`); no
   `/beta/help/` path.
4. Wasm MIME: `dezoomify-wasm.js` served as JavaScript,
   `dezoomify-wasm_bg.wasm` as `application/wasm` (same strict
   content-type assertions as the workflow verify block).
5. No repo files: `/README.md` and `crates/*/Cargo.toml` probes behave
   as the workflow exposure gate requires.
6. `website-deploy` workflow on the switch commit is green: single-app
   verify passes against the production host with the browser user
   agent.
7. `cargo xtask check`, bare `cargo xtask test`, `cargo xtask test
   all`, `cargo xtask ci local` green; markdown-only review confirms
   no code change beyond the checklist (this plan is doc-only until
   the switch commit).

## Rollback

Revert the single switch commit (`git revert <switch-SHA>`; never
rebase, force-push, or otherwise rewrite history). The revert
restores `legacy/` at `/`, the new app at `/beta`, the `/proxy`
shim + route, and the dual-app verify block; the next
`website-deploy` run on `master` redeploys the restored `dist/`.
No data migration exists, so no forward fix-up is needed; if the
switch already deployed, revert first and let the workflow redeploy
before any other `master` push.

## Acceptance

- `dist/` from a clean build matches Verification §2–§5; the
  `website-deploy` verify step passes on production.
- `rg -n "legacy"` (case-sensitive, repository root, untracked
  `dist/`/`wasm/`/generated help excluded by `.gitignore` as today)
  returns nothing except the ONE archive note in `plans/README.md`
  (retired-layout history with removal date + switch-commit SHA).
- `rg -n "/beta|BETA|copyLegacy|LEGACY_EXCLUDE|zoommanager|/proxy"` is
  clean except the same archive note and the historical switch-commit
  message itself: no beta prefix, no legacy copy path, no legacy
  proxy route, no legacy app markers remain in code, config, docs, or
  tests.
- `git status` / `git diff --stat` on the switch shows the checklist
  above and nothing else; history shows exactly one atomic switch
  commit on `master` (revertible per Rollback).

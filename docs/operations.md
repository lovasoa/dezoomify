# Operations

On-call verifies asset digests before interpreting results; source URLs never enter monitoring.

## Release runbook

Stage guarantees: [`releases.md`](releases.md). Green `master` CI auto-publishes the next rolling version.

### Preparing a release

1. Pick a version above `cargo xtask release version`; tag annotated `vX.Y.Z` on `master`.
2. Push the tag; dispatch the `release` workflow with that tag as `ref`.
3. The workflow requires green CI and edits no app manifest.

### Cutting a release

From the tagged revision:

1. `export DEZOOMIFY_VERSION="$(cargo xtask release version)"`
2. `cargo xtask release plan --numbered`
3. `cargo xtask release build --plan target/release-dist/<version>/plan.json --target <target>` per target, each on its matching host (plan lists them; all mandatory).
4. `cargo xtask release verify --plan ... --artifacts target/release-dist/<version>` (names against plan).
5. `cargo xtask release publish --plan ... --artifacts ...`.

Then: GitHub Release publication, plus parallel submission of the exact Chromium ZIP to the Chrome Web Store and Firefox ZIP to AMO. Store jobs rebuild nothing; release artifacts are the source of truth. Submission is automatic; availability waits for store approval. Installers (Linux x86_64 `.deb`, Windows x86_64 `.msi`, Apple silicon `.dmg`) stay unsigned, no paid signing. No in-app updates; users check GitHub Releases manually. Working trees under `target/release-dist/<version>/` are never committed. User install note: [Desktop app guide](user/desktop-app.md#install).

The `release` workflow runs all five stages. Signing and publishing stay separate protected jobs. It then waits for the parallel store submissions; a green release run has reached every target, though store approval is still pending in some cases.

## Website deployment contract

One Cloudflare Pages project (the original `dezoomify`) builds from GitHub Actions via `.github/workflows/website-deploy.yml`:

1. `scripts/build-site.mjs` builds the Vite app, help pages, and wasm glue into `dist/`: legacy site (vendored `legacy/`, verbatim) serves `/`, the new app serves `/beta`, `_routes.json` limits Functions to `/api/proxy` (new) and `/proxy` (legacy, re-exported from `legacy/functions/proxy.js`).
2. A `master` push uploads production. A same-repo PR targeting `master` uploads a preview at `pr-<number>.dezoomify.pages.dev` from the merge ref, so it verifies exactly what merges. Automatic git deployments are off; this workflow is the only publisher, so a push never clobbers production with a raw tree.
3. GitHub records each deploy in `production`/`preview` and links it as the PR's **View deployment**; the preview URL survives new commits.
4. The workflow probes the live deploy (production or preview): both apps, both proxy routes, wasm content types, generated help, no repository files served.

`master` is the single production branch. Fork PRs get no previews: the normal `pull_request` event runs the credentialed job for same-repo PRs only, keeping untrusted code out of `pull_request_target`. Previews are public with `noindex` and share production's proxy and file-exposure gates. Internal docs and plans are never served.

## Update and installer truth

- No auto-update endpoint exists: `release/config.toml` sets `[updater] enabled = false` with empty endpoints, `tauri.conf.json` ships empty updater endpoints, and the desktop capability sets `updater.enabled: false` with an empty allowlist.
- Download published artifacts from the corresponding GitHub Release.
- Linux x86_64, Windows x86_64, and Apple silicon macOS installers ship in every release.

## Service levels

Volunteer best-effort, no uptime/latency/support SLO on website, proxy, or release pipeline. Issue triage is volunteer; see [Incident response](#incident-response). Reproducibility holds instead: every GitHub Release artifact is immutable, so failure means reinstalling the previous immutable release (see [Rollback](#rollback)).

## Rollback

Manual reinstall of the previous immutable GitHub Release artifact, never a rebuild under an existing version. No rollout to pause, no staged deploy: releases publish at once; Chromium uploads stay drafts until published; AMO listed uploads enter review at once. Timing: plan plus per-target builds in minutes on matching hosts, verify under a minute, publish in minutes; missing planned artifacts fail the stage, never a partial release.

1. Pick the previous immutable release tag (`release publish` refuses republishing a tag).
2. Download its artifacts.
3. Reinstall the matching previous `.deb` / `.msi` / `.dmg` by hand; no updater pulls the rollback.
4. Stores accept no old version as a new submission. Revert on `master`, let it produce a higher rolling version, submit that through `store-submit`; never a new store item.
5. Preserve user output and settings; record RTO and tags in the incident record. Verify with the same packaged parity commands.

## Incident response

Owners: release owners in `release/config.toml`. Severity: critical (remote code, key compromise, cookie theft), high (proxy abuse, store compromise), medium (flaky gate, store lag).

1. Pause the affected promotion (website alias or store submission; no updater rollout exists) without rebuilding under the same version.
2. Preserve logs, digests, evidence; revoke test credentials.
3. Follow [Rollback](#rollback) for the affected channel only.
4. Record actions and missing automation in the incident record.

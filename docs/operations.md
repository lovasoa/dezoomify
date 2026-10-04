# Operations

Use immutable release artifacts for publication and rollback. Source URLs never
enter monitoring.

## Release runbook

Green `master` CI auto-publishes the next rolling version. One version covers
all apps and bindings from the same revision. `cargo xtask release version`
derives it from Git: `vX.Y.Z` is `X.Y.Z`; each subsequent first-parent commit
bumps `Z`. Builds receive `DEZOOMIFY_VERSION`, rather than manifest edits.

The release plan freezes the revision, capabilities, and targets from
`release/targets.toml` and `generated/release-capabilities.json`. Every planned
target is mandatory and builds on its matching host. Each stage validates the
previous stage's digests; publication verifies again and requires `origin/master`
to match the plan. Rolling tags use `rolling-v<version>`; numbered tags use `vX.Y.Z`.

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

## Rollback

Reinstall a previous immutable GitHub Release artifact; never rebuild under an
existing version. There is no automatic desktop updater or staged rollout.

1. Pick the previous immutable release tag (`release publish` refuses republishing a tag).
2. Download its artifacts.
3. Reinstall the matching previous `.deb` / `.msi` / `.dmg` by hand; no updater pulls the rollback.
4. Stores accept no old version as a new submission. Revert on `master`, let it produce a higher rolling version, submit that through `store-submit`; never a new store item.
5. Preserve user output and settings; record affected tags and verify the restored app with packaged fixtures.

## Incident response

Contact the release owners in `release/config.toml` for compromised keys,
credential exposure, proxy abuse, or broken publication.

1. Pause the affected promotion (website alias or store submission; no updater rollout exists) without rebuilding under the same version.
2. Preserve logs, digests, evidence; revoke test credentials.
3. Follow [Rollback](#rollback) for the affected channel only.
4. Record evidence and recovery actions in the incident issue.

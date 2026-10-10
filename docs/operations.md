# Operations

Publish immutable artifacts and reuse them for rollback. Never rebuild under an
existing version. Source URLs must not enter monitoring.

## Release runbook

Green `master` CI auto-publishes rolling releases. Numbered versions come from
annotated `vX.Y.Z` tags; subsequent first-parent commits increase the patch
version. One revision/version covers every app and binding.

The release plan freezes its revision and required targets from
[`release/targets.toml`](../release/targets.toml). Builds run on matching hosts;
verification and publication check the frozen plan and artifact digests.
Publication also requires `origin/master` to match the plan.

### Preparing a release

1. Pick a version above `cargo xtask release version`; tag annotated `vX.Y.Z` on `master`.
2. Push the tag and dispatch the `release` workflow with that tag as `ref`.
3. The workflow requires green CI; versions are injected, not edited into manifests.

### Cutting a release

From the tagged revision:

1. `export DEZOOMIFY_VERSION="$(cargo xtask release version)"`
2. `cargo xtask release plan --numbered`
3. `cargo xtask release build --plan target/release-dist/<version>/plan.json --target <target>` for each planned target on its matching host.
4. `cargo xtask release verify --plan ... --artifacts target/release-dist/<version>`
5. `cargo xtask release publish --plan ... --artifacts ...`

The workflow submits the exact Chromium and Firefox release ZIPs to the existing
store listings, without rebuilding. Submission can finish before store approval.
Signing and installation policy: [desktop guide](../apps/desktop/desktop-app.md#install).
Release working trees under `target/release-dist/` are never committed.

## Website deployment contract

[`website-deploy.yml`](../.github/workflows/website-deploy.yml) is the sole publisher
to the original Cloudflare Pages project, `dezoomify`; automatic Git deployment
is disabled. [`build-site.mjs`](../scripts/build-site.mjs) assembles legacy files
verbatim at `/`, the new app/help at `/beta`, and both proxy routes.

`master` publishes production. Same-repository PRs targeting `master` publish a
stable `pr-<number>.dezoomify.pages.dev` preview from the merge ref. Fork PRs get
no credentialed preview. Previews are public with `noindex`; internal source and
docs must not be served. Deployment probes check both apps, proxies, WASM, help,
and source-file exclusion.

## Rollback

- Reinstall a previous immutable GitHub Release artifact, preserving output and
  settings. Desktop has no automatic updater.
- Stores require a higher version: revert on `master` and submit the resulting
  release through `store-submit`, retaining the existing listing.
- Verify recovery with packaged fixtures and record affected tags in the incident.

## Incident response

Contact release owners in [`release/config.toml`](../release/config.toml) for
compromised keys, credential exposure, proxy abuse, or broken publication.
Pause the affected publication, preserve evidence, revoke affected credentials,
and follow the relevant rollback path. Record recovery actions in the incident
issue rather than a new documentation page.

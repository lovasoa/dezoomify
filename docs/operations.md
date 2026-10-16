# Operations

Publish immutable artifacts and reuse them for rollback. Never rebuild under an
existing version. Source URLs must not enter monitoring.

## Release runbook

Green `main` CI auto-publishes rolling releases. Numbered versions come from
annotated `vX.Y.Z` tags; subsequent first-parent commits increase the patch
version. One revision/version covers every app and binding.

The release plan freezes its revision and required targets from
[`release/targets.toml`](../release/targets.toml). Builds run on matching hosts;
verification and publication check the frozen plan and artifact digests.
Publication also requires `origin/main` to match the plan.

### Preparing a release

1. Pick a version above `cargo xtask release version`; tag annotated `vX.Y.Z` on `main`.
2. Push the tag and dispatch the `release` workflow with that tag as `ref`.
3. The workflow requires green CI; versions are injected, not edited into manifests.

### Cutting a release

From the tagged revision:

1. `export DEZOOMIFY_VERSION="$(cargo xtask release version)"`
2. `cargo xtask release plan --numbered`
3. `cargo xtask release build --plan target/release-dist/<version>/plan.json --target <target>` for each planned target on its matching host.
4. `cargo xtask release verify --plan ... --artifacts target/release-dist/<version>`
5. `cargo xtask release publish --plan ... --artifacts ...`

Signing and installation policy: [desktop guide](../apps/desktop/desktop-app.md#install).
Release working trees under `target/release-dist/` are never committed.

### Nightly extension store submissions

GitHub releases publish continuously; [`store-nightly`](../.github/workflows/store-nightly.yml)
runs at 02:30 UTC and freezes the latest published release once for both stores.
Each store submits that release's checksummed ZIP only when its commit differs
from the last accepted submission. Missed nights accumulate changes. Scheduled
runs may be delayed; automatic mutations are permitted only before 06:00 UTC,
and at most one attempt per store per UTC date is allowed. Submission acceptance
does not mean store review or approval has completed.

The `store-submit` environment holds the existing OAuth/AMO secrets. Chromium
also requires the public Actions variable `CHROME_WS_PUBLISHER_ID`, copied from
the Chrome developer dashboard's publisher account. This workflow uses Chrome
API v2 because [v1 support ended on 15 October 2026](https://developer.chrome.com/docs/webstore/api/v1).
The extension IDs remain in `release/config.toml`; uploads update existing listings.

Dispatch [`store-submit`](../.github/workflows/store-submit.yml) with an explicit
`release_tag`, browser, and `submit=true` for an emergency submission. Manual
submissions bypass time and daily limits, reuse the exact release ZIP, and update
the same records. Leaving `submit=false` only builds a dry-run artifact; pushes
that touch the extension also retain this dry-run check.

GitHub deployment records with task `store-submit` and environments
`store-chromium` / `store-firefox` persist attempts and outcomes. Per-store job
concurrency serializes every entry point. A recorded `error`, `in_progress`, or
missing status since the last confirmed submission blocks automatic retries: the store may have accepted a request
whose response was lost. Inspect that record's version and the store dashboard;
then append a deployment status with `auto_inactive=false`: `success` only if
the intended version was accepted, or `failure` after confirming it was not.
For example, use `gh api --method POST repos/OWNER/REPO/deployments/ID/statuses
-f state=success -F auto_inactive=false -f description='Verified version in store'`.
Do not delete attempt records; they enforce the daily limit even after failures.
A successful manual submission also reconciles older uncertain attempts and
establishes a new baseline; ledger reads stop at the most recent success.

Desktop release builds require the repository Actions secret
`TAURI_SIGNING_PRIVATE_KEY`, containing the Tauri signing key, and optionally
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for an encrypted key. Keep a secure backup:
losing this key prevents existing installations from trusting future updates.
The matching public key is committed in the desktop Tauri configuration.
Local bundles omit updater signatures when no signing key is supplied.

Release verification checks every updater bundle against the public key before
publication. Each GitHub Release carries `latest.json` with signatures and
version-specific download URLs. The app follows GitHub's latest release,
including rolling releases, and asks before installation. Linux `.deb` and
Windows `.msi` installations may require administrator approval.

### Apple signing setup

Configure the repository Actions secrets used by the macOS step in
[`release.yml`](../.github/workflows/release.yml), following
[Tauri's Developer ID and notarization setup](https://v2.tauri.app/distribute/sign/macos/).
Use a **Developer ID Application** certificate exported with its private key as a
base64-encoded, password-protected `.p12`, and an **app-specific** Apple password.
Export the `.p12` from Keychain Access: OpenSSL 3's default PKCS#12 format can fail
macOS Keychain import. Back up the certificate and key; renew before expiry.
Apple credentials are separate from the existing Tauri updater signing key.

`cargo xtask release build` signs, notarizes, and verifies the macOS DMG and
updater app, then installs and launches both. Before merging,
run `gh workflow run desktop.yml --ref <reviewed-branch>` and require success.
This uploads test artifacts without publishing. Automatic PR builds stay ad-hoc.

## Website deployment contract

[`website-deploy.yml`](../.github/workflows/website-deploy.yml) is the sole publisher
to the original Cloudflare Pages project, `dezoomify`; automatic Git deployment
is disabled. [`build-site.mjs`](../scripts/build-site.mjs) assembles legacy files
verbatim at `/`, the new app/help at `/beta`, and both proxy routes.

`main` publishes production. Set the Cloudflare Pages project's production branch
to `main` so Wrangler classifies these uploads as production.
Same-repository PRs targeting `main` publish a
stable `pr-<number>.dezoomify.pages.dev` preview from the merge ref. Fork PRs get
no credentialed preview. Previews are public with `noindex`; internal source and
docs must not be served. Deployment probes check both apps, proxies, WASM, help,
and source-file exclusion.

## Rollback

- Reinstall a previous immutable GitHub Release artifact, preserving output and
  settings. The desktop updater only installs newer versions; rollback is manual.
- Stores require a higher version: revert on `main` and submit the resulting
  release through `store-submit`, retaining the existing listing.
- Verify recovery with packaged fixtures and record affected tags in the incident.

## Incident response

Contact release owners in [`release/config.toml`](../release/config.toml) for
compromised keys, credential exposure, proxy abuse, or broken publication.
Pause the affected publication, preserve evidence, revoke affected credentials,
and follow the relevant rollback path. Record recovery actions in the incident
issue rather than a new documentation page.

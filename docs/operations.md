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

Desktop release builds require the repository Actions secret
`TAURI_SIGNING_PRIVATE_KEY`, containing the Tauri signing key, and optionally
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for an encrypted key. Keep a secure backup:
losing this key prevents existing installations from trusting future updates.
The matching public key is committed in the desktop Tauri configuration.
Local bundles omit updater signatures when no signing key is supplied.

macOS releases additionally require the Apple secrets described below. The
release workflow signs the app and DMG with Developer ID, notarizes both, and
staples Apple's tickets. It verifies the expected team, app identifier, hardened
runtime, Gatekeeper acceptance, and tickets in both the DMG and updater archive
before uploading artifacts. Local and PR smoke builds retain ad-hoc signing.

Release verification checks every updater bundle against the public key before
publication. Each GitHub Release carries `latest.json` with signatures and
version-specific download URLs. The app follows GitHub's latest release,
including rolling releases, and asks before installation. Linux `.deb` and
Windows `.msi` installations may require administrator approval.

### Apple signing setup

Complete this before merging signing changes: green `master` CI automatically
starts a release, and missing Apple secrets now fail the macOS build.

1. On a Mac, use the paid Apple Developer Program's Account Holder account to
   create a **Developer ID Application** certificate for distribution outside
   the App Store. In Keychain Access, choose **Certificate Assistant → Request
   a Certificate From a Certificate Authority**, save the CSR, then upload it
   under [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list).
   Download and open the resulting `.cer` on the same Mac so it pairs with the
   private key. An Apple Development or Mac App Distribution certificate will
   not work for these releases. See [Apple's Developer ID guide](https://developer.apple.com/developer-id/).
2. In Keychain Access's **login → My Certificates**, export the certificate
   **with its private key** as a password-protected `.p12`. Store it outside
   the repository, with a secure backup and its export password. A `.cer` alone
   cannot sign. Convert the `.p12` without printing its contents:

   ```sh
   openssl base64 -A -in /secure/path/dezoomify.p12 -out /secure/path/certificate-base64.txt
   security find-identity -v -p codesigning
   ```

   Copy the full identity from the second command, such as
   `Developer ID Application: Your Name (ABCDEFGHIJ)`.
3. Find your Team ID under [Developer membership](https://developer.apple.com/account#MembershipDetailsCard).
   In [Apple Account](https://account.apple.com/), under **Sign-In and Security →
   App-Specific Passwords**, generate a password for Dezoomify notarization.
   Use this password rather than your normal account password. The Apple ID
   must belong to the same team as the certificate. This follows
   [Tauri's Apple ID notarization setup](https://v2.tauri.app/distribute/sign/macos/#notarization).
4. Add these **repository secrets** under
   [Settings → Secrets and variables → Actions](https://github.com/lovasoa/dezoomify/settings/secrets/actions).
   The macOS build job consumes repository secrets, not the later
   `release-signing` or `release-publish` environments.

   | Secret | Value |
   |---|---|
   | `APPLE_CERTIFICATE` | Contents of `certificate-base64.txt` |
   | `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password |
   | `APPLE_SIGNING_IDENTITY` | Full `Developer ID Application: … (TEAMID)` identity |
   | `APPLE_ID` | Apple account email |
   | `APPLE_PASSWORD` | App-specific password for notarization |
   | `APPLE_TEAM_ID` | Team ID from membership |

   Keep the existing `TAURI_SIGNING_PRIVATE_KEY` and optional password: Apple
   signing and updater signatures serve different purposes. Do not replace the
   updater key or public key. Tauri imports the Apple certificate into a
   temporary keychain; no persistent runner keychain setup is needed.
5. Merge the PR after CI passes. The normal rolling release signs and notarizes
   automatically; numbered releases follow the existing release instructions.
   The first notarization can take longer than subsequent submissions. If it
   fails, inspect the macOS build's submission ID and retrieve Apple's report
   with `xcrun notarytool log <submission-id> --apple-id <email> --team-id <team-id>`
   (enter the app-specific password when prompted). Fix the reported cause
   before releasing; do not skip notarization or stapling to publish.
6. Download the published DMG through a browser on a clean Apple silicon Mac,
   drag the app into Applications, and open it. Confirm that no **Open Anyway**
   exception is needed, then exercise **Help → Check for updates…** with a newer
   signed release. CI verifies artifacts but cannot reproduce Finder quarantine
   and the full upgrade experience.

For a local signed build on macOS, export the same six `APPLE_*` values and run
`cargo xtask build desktop`; `APPLE_SIGNING_IDENTITY` overrides the checked-in
ad-hoc identity. Tauri notarizes the app before creating its updater archive.
The release workflow additionally notarizes the finished DMG. Keep credentials
outside shell history, logs, and the repository. Renew expiring certificates and
update these secrets before the next release.

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
  settings. The desktop updater only installs newer versions; rollback is manual.
- Stores require a higher version: revert on `master` and submit the resulting
  release through `store-submit`, retaining the existing listing.
- Verify recovery with packaged fixtures and record affected tags in the incident.

## Incident response

Contact release owners in [`release/config.toml`](../release/config.toml) for
compromised keys, credential exposure, proxy abuse, or broken publication.
Pause the affected publication, preserve evidence, revoke affected credentials,
and follow the relevant rollback path. Record recovery actions in the incident
issue rather than a new documentation page.

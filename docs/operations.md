# Operations

On-call verifies asset digests before interpreting results; source URLs never enter monitoring. Rollback: `docs/rollback-runbook.md`.

## Release runbook

What each stage guarantees is the contract in [`releases.md`](releases.md).
Successful `master` CI automatically publishes the next rolling version.

### Preparing a release

1. Choose a version greater than `cargo xtask release version` and create the
   annotated `vX.Y.Z` tag on `master`.
2. Push the tag and dispatch the `release` workflow with that tag as `ref`.
3. The workflow requires successful CI and edits no app manifest.

### Cutting a release

Run from the tagged revision:

1. `export DEZOOMIFY_VERSION="$(cargo xtask release version)"`
2. `cargo xtask release plan --numbered`
3. `cargo xtask release build --plan target/release-dist/<version>/plan.json --target <target>` for every target (each build runs on its matching host; the plan lists them and all are mandatory).
4. `cargo xtask release verify --plan target/release-dist/<version>/plan.json --artifacts target/release-dist/<version>` (checks the produced artifact names against the plan).
5. `cargo xtask release publish --plan ... --artifacts ...`.

The automatic sequence is `master` CI, GitHub Release publication, then
parallel submission of the exact released Chromium ZIP to the Chrome Web Store
and Firefox ZIP to AMO. The store jobs do not rebuild the extension; GitHub
Release artifacts are the source of truth. Submission is automatic, but store
review remains external and public availability waits for Chrome Web Store or
AMO approval. The Linux x86_64 `.deb`, Windows x86_64 `.msi`, and Apple silicon
macOS `.dmg` installers remain unsigned with no paid Apple/Azure signing. Automatic in-app updates are
disabled; users check GitHub Releases manually. Working trees under
`target/release-dist/<version>/` are never committed. The user-facing install
note lives in the [Desktop app guide](user/desktop-app.md#install).

The `release` workflow performs all five stages. Signing and publishing remain
separate protected jobs. It then waits for the parallel reusable store
submission jobs; a successful release run has reached every distribution target,
though store approval can still be pending.

## Update and installer truth

- No auto-update endpoint exists: `release/config.toml` sets `[updater] enabled = false` with empty endpoints, `tauri.conf.json` ships empty updater endpoints, and the desktop capability sets `updater.enabled: false` with an empty allowlist.
- Download published artifacts from the corresponding GitHub Release.
- Linux x86_64, Windows x86_64, and Apple silicon macOS installers ship in every release.

## Service levels

Dezoomify runs as a volunteer best-effort project with no uptime, latency,
or support-response SLO: the website, the metadata CORS proxy, and the
release pipeline carry no availability target, and issue reports receive
volunteer triage per [Incident response](incident-response.md). What holds
instead is reproducibility: every GitHub Release artifact is immutable, so an
operator reinstalls the previous immutable release on failure (see
`docs/rollback-runbook.md`).

## Rollback

Rollback is a manual reinstall of the previous immutable GitHub Release artifact (never a rebuild under an existing version); see `docs/rollback-runbook.md`. There is no update rollout to pause and no staged-percentage deploy: releases publish at once, Chromium store uploads are drafts until published, and AMO listed uploads enter review immediately. Expected operator timing: plan plus per-target builds in minutes on their matching hosts, verify in under a minute, and publish in minutes; missing planned artifacts fail the stage rather than shipping a partial release.

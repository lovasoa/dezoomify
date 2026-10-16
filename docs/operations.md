# Operations

Publish immutable artifacts and reuse them for rollback. Never rebuild under an
existing version. Source URLs must not enter monitoring.

## Release runbook

Use the [publication workflows](../.github/workflows/) for schedules, inputs and
credentials, and [release tooling](../crates/xtask/src/release/) for versioning
and artifact checks. Reuse verified artifacts for downloads, store submissions
and updates; store acceptance does not mean review has completed.

Keep signing keys backed up and separate from source. Losing the updater key
prevents existing installations from trusting future updates. Follow
[Tauri's signing guidance](https://v2.tauri.app/distribute/sign/macos/) and verify
installation with the [desktop workflow](../.github/workflows/desktop.yml)
before publishing. Installation help belongs in the [desktop guide](../apps/desktop/desktop-app.md).

## Website deployment contract

The [deployment workflow](../.github/workflows/website-deploy.yml) is the sole
publisher of the [assembled site](../scripts/build-site.mjs). Preserve the legacy
app byte for byte. Previews are public: exclude private source and credentials.

## Rollback

Reinstall a previous immutable release to recover a desktop installation.
Stores and automatic updates require increasing versions: revert the code and
release a newer version rather than replacing an existing artifact.

## Incident response

Pause affected publishers, rotate compromised credentials and preserve release
provenance. Record recovery decisions in the incident, not another guide.

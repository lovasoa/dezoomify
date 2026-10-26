# Operations

Publish immutable artifacts and reuse them for rollback. Never rebuild under an
existing version. Source URLs must not enter monitoring.

## Release runbook

The [release workflow](../.github/workflows/release.yml) publishes desktop, CLI
and extensions together, at most once per UTC date. Versions and tags use
`YY.M.D` without leading zeroes. A delayed schedule is still valid. Unchanged
source commits and already-published dates stop before builds or store jobs.
Retry failed jobs to resume a partial publication using its frozen artifacts;
stores that already accepted that version are not submitted again.
Manual dispatch publishes the selected branch after its exact commit passes CI.
Store acceptance does not mean review has completed. Uncertain submissions and
incomplete draft releases require reconciliation before retrying.

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

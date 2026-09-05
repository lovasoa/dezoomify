# Operations

On-call verifies asset digests before interpreting results; source URLs never enter monitoring. Rollback: `docs/rollback-runbook.md`.

## Release runbook

What each stage guarantees is the contract in [`releases.md`](releases.md); this is the operator sequence. The release version is one version across all apps; `release plan` fails closed when any app manifest disagrees, so a missed bump cannot ship.

### Preparing a release

1. Bump the version in `release/config.toml` and every app manifest it appears in (CLI, desktop, extension; `release plan` lists any file you missed).
2. Optionally add curated user-visible changes to `release/notes/<version>.md`; it is included verbatim in the release notes.
3. Pass the deterministic gates: `cargo xtask check && cargo xtask test all`.
4. Commit to `master`, push, create and push the annotated tag `v<version>`. Publish refuses when the tag does not point at the revision the plan pinned.

### Cutting a release

Run from the tagged revision:

1. `cargo xtask release plan`
2. `cargo xtask release build --plan target/release-dist/<version>/plan.json --target <target>` for every available target (the CLI target needs a Linux host; the plan lists them).
3. `RELEASE_GPG_KEY="$(cat <signing-key.asc>)" cargo xtask release sign` (fails closed without the key; the public key is `release/gpg-public-key.asc`).
4. `cargo xtask release verify --plan target/release-dist/<version>/plan.json --artifacts target/release-dist/<version>`
5. `cargo xtask release publish --plan ... --artifacts ...`, then commit and push the recorded `release/checksums/<version>/SHA256SUMS`.

Steps 1 and 2 also run in CI: dispatch `release-build` with the tag, then `release-sign` and `release-publish` with the run ids; in CI the signing key comes from the `release-signing` environment secret. The Chromium artifact from step 2 is the store payload for the existing listing, submitted through the `store-submit` workflow.

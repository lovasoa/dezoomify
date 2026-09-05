# Releases

The monorepo produces coordinated core libraries, protocol bindings, the website, extension, CLI, and desktop artifacts. A release records one version and the exact protocol range each artifact supports.

## Versioning

The release version identifies a tested source revision across all apps. The protocol has an independent version because installed extensions and native applications do not update at the same time. Schema fingerprints identify exact generated contracts; they supplement rather than replace protocol versions.

Backward-compatible protocol additions keep the current major version. Removed fields, changed meanings, or incompatible command and event behavior require a new protocol major version. Error codes remain stable within a supported protocol major.

## Compatibility

Web, extension, and desktop perform the [version handshake](protocol.md#version-handshake) before sending job commands. Each artifact supports a documented rolling range of protocol versions. A peer outside that range stops safely and receives `protocol.incompatible` with the appropriate update action.

Handoff data carries app version, protocol version, schema fingerprint, and required capabilities. Receivers reject incompatible or expired data before confirmation or effects. Only the extension-to-native channel can separately request consent for scoped cookies.

## Release gates

A release candidate passes:

- full Rust and TypeScript formatting, lint, and unit suites;
- Rust-source-to-TypeScript-and-schema generation checks and clean-tree checks;
- shared scenarios on native, WASM, shared UI, extension, Tauri, and CLI targets;
- supported browser and operating-system smoke tests;
- protocol upgrade, downgrade, event-gap, and handoff fixtures;
- encoder output and large-image boundary tests;
- website direct-first request-order and classified automatic proxy-fallback tests;
- proxy public-resource eligibility, credential omission, redirect, active-transport display, and opt-out audits;
- extension permission, native cookie-consent, Native Messaging sender-authentication and replay-defense, redaction, and dependency audits.

## Pipeline

`cargo xtask release plan|build|sign|verify|publish` is the only release
orchestration; every stage validates the previous stage's digests and fails
closed on missing inputs, tools, or secrets. The plan stage freezes a
deterministic contract (version, tag, commit, protocol range, schema
fingerprint, capabilities, targets) from `release/config.toml`,
`release/targets.toml`, `release/compatibility.toml`, and
`generated/release-capabilities.json`. The build stage produces one target's
artifact plus a per-target digest fragment on the matching host; unavailable
targets refuse to build. The sign stage assembles the aggregate `SHA256SUMS`
from the fragments in plan order and GPG-detach-signs it and every artifact;
it runs only with the release signing key (the `release-signing`
environment secret) and the public key lives at
`release/gpg-public-key.asc`. The verify stage recomputes every digest,
checks artifact names against the plan, and validates every signature. The
publish stage verifies again, then creates the GitHub release from the
planned commit with artifacts, checksums, signatures, and notes, and
records the inventory at `release/checksums/<version>/SHA256SUMS`.

The `release-build`, `release-sign`, and `release-publish` workflows chain
these stages by run id: the build workflow runs `cargo xtask ci local` on
the tagged revision before planning, and no artifact exists that has not
passed the deterministic suite. Desktop installers stay an unavailable
target until the Tauri shell is real; the inventory marks them so, and a
release never claims an artifact it did not build.

Artifacts are built from a tagged revision, signed with free mechanisms only (updater keypair, store submission, GPG tags), and published with checksums, schema fingerprint, supported protocol range, capabilities, and user-visible changes. Desktop installers ship unsigned: paid Apple/Azure signing is out of plan for a free project. Web release notes identify the automatic metadata CORS proxy fallback, active-transport indicator, and opt-out behavior; they do not describe proxy use as per-attempt consent. The compatibility matrix remains available so peers can determine whether to update, use another runtime, or continue safely.

See [Testing](testing.md) for test structure and [Security](security.md) for trust requirements.

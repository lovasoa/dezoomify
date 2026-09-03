# Releases

The monorepo produces coordinated core libraries, protocol bindings, Web Studio, extension, CLI, and desktop artifacts. A release records one product version and the exact protocol range each artifact supports.

## Versioning

The product version identifies a tested source revision across all surfaces. The protocol has an independent version because installed extensions and native applications do not update at the same time. Schema fingerprints identify exact generated contracts; they supplement rather than replace protocol versions.

Backward-compatible protocol additions keep the current major version. Removed fields, changed meanings, or incompatible command and event behavior require a new protocol major version. Error codes remain stable within a supported protocol major.

## Compatibility

Web, extension, and desktop perform the [version handshake](protocol.md#version-handshake) before sending job commands. Each artifact supports a documented rolling range of protocol versions. A peer outside that range stops safely and receives `protocol.incompatible` with the appropriate update action.

Handoff data carries product version, protocol version, schema fingerprint, and required capabilities. Receivers reject incompatible or expired data before confirmation or effects. Only the extension-to-native channel can separately request consent for scoped cookies.

## Release gates

A release candidate passes:

- full Rust and TypeScript formatting, lint, and unit suites;
- Rust-source-to-TypeScript-and-schema generation checks and clean-tree checks;
- shared scenarios on native, WASM, Studio, extension, Tauri, and CLI adapters;
- supported browser and operating-system smoke tests;
- protocol upgrade, downgrade, event-gap, and handoff fixtures;
- encoder output and large-image boundary tests;
- website direct-first request-order and classified automatic proxy-fallback tests;
- proxy public-resource eligibility, credential omission, redirect, active-transport display, and opt-out audits;
- extension permission, native cookie-consent, Native Messaging sender-authentication and replay-defense, redaction, and dependency audits.

Artifacts are built from a tagged revision, signed where the platform supports signing, and published with checksums, schema fingerprint, supported protocol range, capabilities, and user-visible changes. Web release notes identify the automatic restricted-proxy fallback, active-transport indicator, and opt-out behavior; they do not describe proxy use as per-attempt consent. The compatibility matrix remains available so old clients can determine whether to update, use another runtime, or continue safely.

See [Testing](testing.md) for test structure and [Security](security.md) for trust requirements.

# Documentation

## Use Dezoomify

Start with the [user guides](user/README.md) to choose an app, save an image,
or solve a download problem. These pages also generate the website help.

## Contribute

- [Development](development.md): setup, build outputs, local servers, and validation.
- [Architecture](architecture.md): dependency boundaries, bindings, and job ownership.
- [Algorithm](algorithm.md): discovery precedence, retries, cancellation, and recovery.
- [Contributing a format](CONTRIBUTING-format.md): add a parser and a reproducible fixture.
- [Testing](testing.md): choose coverage and build deterministic fixtures.
- [Browser runtime](browser-runtime.md): fetching and canvas behavior.
- [Extension](extension.md): source-document lifetime and permission pitfalls.
- [Native apps](native-apps.md): resource ownership, publication, and desktop builds.
- [Security](security.md): credentials and trust boundaries.
- [Operations](operations.md): releases, website deployment, and rollback.
- [Licensing](licensing.md): imported-source grants and notice retention.
- [Privacy](privacy.md): how the apps handle user data.

For exact commands, use `cargo xtask --help` or the
[command reference](../crates/xtask/README.md). Types and capabilities live in
[source](../crates/dezoomify/src/model.rs) and [generated manifests](../generated/),
rather than duplicate prose tables.

The [documentation rule](../AGENTS.md#documentation) defines what belongs here:
answer a useful reader question, keep one home for each answer, and remove
material that merely narrates the code.

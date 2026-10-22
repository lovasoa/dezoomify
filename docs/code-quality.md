# Caller contracts

A caller should be able to use a module correctly from its declarations and
linked contracts. Prefer simpler types, names, or interfaces when they can remove
an obligation; comments should explain what the code cannot express.

Production modules should briefly state their responsibility and important
boundaries. Document module-facing APIs at any visibility and nontrivial private
operations where correct use depends on facts beyond their types:

- Input meaning: units, coordinate systems, index scope, and validation ownership.
- Preconditions and effects: required state, transitions, and what results require next.
- Resources: who retains, transfers, closes, or releases them.
- Ordering: overlap, repeated or late calls, and synchronous callbacks.
- Failure: partial effects, retryability, cancellation, and settlement obligations.

Omit inapplicable topics and facts obvious from the declaration. Keep the contract
at its owner; implementations need only describe additional constraints. Avoid
restating an algorithm, requiring headings, or adding comments to satisfy a count.

Before writing a contract, read the implementation, affected callers, and behavior
tests. Resolve contradictions by simplifying the interface, enforcing a necessary
precondition, or correcting behavior. Update the contract in the same change when
caller expectations change, even if the signature does not. Review lifecycle
claims against actual cleanup and cancellation paths; add a behavior test when an
unresolved guarantee needs coverage.

[`Host`](../crates/dezoomify/src/host.rs) is an example: its lifecycle and capability
comments generate both Rust rustdoc and TypeScript JSDoc. Boundary value contracts
live in [`model.rs`](../crates/dezoomify/src/model.rs). Regenerate bindings rather
than documenting generated declarations separately.

`cargo xtask check` enforces missing Rust docs in the cleaned Host scope and builds
core rustdoc with private items and broken-link errors. These checks catch omissions
and stale links; implementation-aware review establishes contract accuracy.

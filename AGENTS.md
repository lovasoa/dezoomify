Use a shared Rust algorithm through injected `Host` capabilities. Keep product
features in their product when that is simpler; products never import each other.

## Boundaries

- Preserve `legacy/` byte for byte when assembling the website.
- Define cross-language values in `crates/dezoomify/src/model.rs`; import generated
  bindings and run `cargo xtask bindings generate` after boundary changes.
  Branch on error `kind` and structured facts.
- Keep exact URLs, settings, and error causes in bounded local diagnostics.
  Never record cookies or authentication headers. Reports are shared only by
  explicit user action; do not promise automatic sanitization.
- Do not commit website output. Track generated files only in
  `packages/wasm-bindings` and `generated/*.json`.
- Use Node for authored HTTP servers, including Rust fixtures. Live tests are opt-in.
- Read before editing, use `apply_patch`, and preserve unrelated work.

## Source contracts and instructions

Prefer types and interfaces that enforce correct use. Comment only on obligations
or rationale the declarations cannot express: ownership, ordering, units, partial
effects, cancellation, and failure recovery. Read implementations, callers, and
behavior tests before claiming a guarantee; update the owning declaration when
behavior changes. Do not narrate code or repeat a contract at its callers.

Keep development instructions short in `AGENTS.md` at the deepest directory
containing their scope. Put explanations of code beside that code. Preserve
user-facing help in `docs/user/` and `apps/desktop/desktop-app.md`; link to source
or command help for changing inventories, values, and schemas.

## Validation

Test user-observable behavior at its owning layer. Never assert source contents,
architecture, wiring, or helper call shapes. Prefer a minimal shared product
fixture over repeated successful saves. Use controlled clocks and barriers for
pending work; register cleanup before assertions. Not every change needs a test.

Choose checks by risk using `cargo xtask --help`. `cargo xtask test all` covers
shared product behavior; `cargo xtask ci local` adds static checks and audit.
Keep modules focused; a third copy of logic calls for a shared abstraction.

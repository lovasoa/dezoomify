# Rust Crates

- **Responsibility:** Hold reusable Rust libraries and repository tooling with
  explicit pure, portable, native, browser, fixture, and task-runner boundaries.
- **Allowed dependencies:** Dependencies flow from hosts toward `job`, `core`,
  and `protocol`; leaf crates remain independent and applications compose them.
- **Forbidden responsibilities:** Do not place UI or app-specific policy
  here, create cycles, or make `core`/`protocol` depend on runtime hosts.
- **Interfaces and tests:** Every crate exposes a narrow documented API and owns
  unit, architecture, and boundary tests appropriate to that API.
- **Migration sources:** Rust discovery/native behavior starts in
  `migration-sources/dezoomify-rs`; browser and extension behavior may supply
  parity cases but not crate architecture.

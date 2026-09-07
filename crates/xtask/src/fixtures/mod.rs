//! `cargo xtask fixtures verify|serve|capture`.
//!
//! Verification is read-only: schemas, route/payload references, byte hashes,
//! sizes, duplicate IDs, incompatible duplicate served URLs, unlisted/missing
//! files, unsafe traversal, provenance, and sensitive flags. Serve spawns the
//! deterministic fixture server on loopback. Capture fetches public metadata
//! over the network (explicit, low-volume, like `test live`) and saves
//! redacted `routes.json` plus payloads for pull requests; it never sends or
//! stores credentials (see `docs/security.md` and
//! `docs/CONTRIBUTING-format.md`).
//!
//! The command is split by stage (`verify`, `serve`, `capture`) over shared
//! corpus helpers (`common`) so no single file carries the whole command
//! (todo 6.2 xtask slim-down). The subcommand surface and strict
//! unknown-argument rejection are unchanged; the stable surface is
//! documented in `crates/xtask/README.md` and pinned by
//! `crates/xtask/tests/cli_surface.rs`.

mod capture;
mod common;
mod serve;
mod verify;

pub use capture::capture;
pub use serve::serve;
pub use verify::verify;

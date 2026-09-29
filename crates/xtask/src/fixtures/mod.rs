//! `cargo xtask fixtures verify|serve|capture`.
//!
//! Verification is read-only: scenario metadata, route/payload references, byte hashes,
//! sizes, duplicate IDs, incompatible duplicate served URLs, unlisted/missing
//! files, unsafe traversal, provenance, and sensitive flags. Serve spawns the
//! deterministic fixture server on loopback. Capture fetches public metadata
//! over the network (explicit, low-volume, like `test live`) and saves
//! `routes.json` plus payloads for pull requests; it never sends or
//! stores credentials (see `docs/security.md` and
//! `docs/CONTRIBUTING-format.md`).

mod capture;
mod common;
mod serve;
mod verify;

pub use capture::capture;
pub use serve::serve;
pub use verify::verify;

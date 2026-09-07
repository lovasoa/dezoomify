//! `cargo xtask release plan|build|sign|verify|publish`: the real release
//! pipeline. Every stage validates the previous stage's digests and fails
//! closed on missing inputs, secrets, or tools (docs/releases.md).
//!
//! Layout under `target/release-dist/<version>/` (never committed; `target/`
//! is chosen so website builds cannot clobber release trees):
//!   plan.json      deterministic frozen release contract
//!   notes.md       release notes (metadata + curated `release/notes/<v>.md`)
//!   SHA256SUMS     aggregate digest manifest (published)
//!   <target>/<artifact>   one directory per buildable target
//!   <file>.sig     GPG detached signatures over the published files
//!
//! The published inventory is recorded at `release/checksums/<version>/`.
//!
//! The pipeline is split by stage (`plan`, `build`, `sign`, `verify`,
//! `publish`) over shared inventory and digest helpers (`common`) so no
//! single file carries the whole pipeline (todo 6.2 xtask slim-down). The
//! command surface and strict unknown-argument rejection are unchanged; the
//! stable surface is documented in `crates/xtask/README.md` and pinned by
//! `crates/xtask/tests/cli_surface.rs`.

mod build;
mod common;
mod plan;
mod publish;
mod sign;
mod verify;

pub fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("plan") => plan::plan_cmd(&args[1..]),
        Some("build") => build::build_cmd(&args[1..]),
        Some("sign") => sign::sign_cmd(&args[1..]),
        Some("verify") => verify::verify_cmd(&args[1..]),
        Some("publish") => publish::publish_cmd(&args[1..]),
        Some(other) => Err(format!("unknown release subcommand '{other}'")),
        None => Err("usage: cargo xtask release <plan|build|sign|verify|publish>".to_string()),
    }
}

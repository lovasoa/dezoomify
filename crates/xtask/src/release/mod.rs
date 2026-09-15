//! `cargo xtask release plan|build|verify|publish`: the real release
//! pipeline. Every stage validates the frozen release plan and fails closed
//! on missing inputs or tools (docs/releases.md).
//!
//! Layout under `target/release-dist/<version>/` (never committed; `target/`
//! is chosen so website builds cannot clobber release trees):
//!   plan.json      deterministic frozen release contract
//!   notes.md       user-facing release description and changes
//!   <target>/<artifact>   one directory per buildable target
//!
//! The pipeline is split by stage (`plan`, `build`, `verify`, `publish`) over
//! shared inventory helpers (`common`) so no
//! single file carries the whole pipeline (todo 6.2 xtask slim-down). The
//! command surface and strict unknown-argument rejection are unchanged; the
//! stable surface is documented in `crates/xtask/README.md` and pinned by
//! `crates/xtask/tests/cli_surface.rs`.

mod build;
mod common;
mod plan;
mod publish;
mod verify;

pub fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("version") => {
            crate::reject_unknown_args("release version", &args[1..])?;
            println!("{}", common::app_version()?.0);
            Ok(())
        }
        Some("plan") => plan::plan_cmd(&args[1..]),
        Some("build") => build::build_cmd(&args[1..]),
        Some("verify") => verify::verify_cmd(&args[1..]),
        Some("publish") => publish::publish_cmd(&args[1..]),
        Some(other) => Err(format!("unknown release subcommand '{other}'")),
        None => Err("usage: cargo xtask release <version|plan|build|verify|publish>".to_string()),
    }
}

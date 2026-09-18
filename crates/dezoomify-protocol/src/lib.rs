//! Authoritative typed contracts for job commands, host effects, events,
//! errors, and native messaging. Browser bindings are derived from these
//! Rust types by the WASM build.

// Contract errors intentionally carry structured context (transport, blocked
// reason, resource kind, recovery actions); boxing them has no runtime benefit.
#![allow(clippy::result_large_err)]
#![forbid(unsafe_code)]
// Shipped code maps failures to typed protocol errors instead of
// panicking. Unit tests are exempt via `allow-unwrap-in-tests` in the
// workspace `clippy.toml`; integration `tests/` targets never inherit this
// crate-root attribute.
#![deny(clippy::unwrap_used)]

pub mod dto;

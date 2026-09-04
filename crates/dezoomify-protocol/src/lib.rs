//! Canonical protocol version 1: the single authored source for commands,
//! effects, responses, events, capabilities, handoff, output, recovery, and
//! errors. `packages/protocol-ts` is generated from [`dto`]; never duplicate
//! these shapes by hand.

// Protocol errors intentionally carry structured context (transport, blocked
// reason, resource kind, recovery actions); boxing them would complicate the
// canonical JSON projection without runtime benefit.
#![allow(clippy::result_large_err)]

pub mod codec;
pub mod dto;
pub mod generate;

pub use dto::{PROTOCOL_MAJOR, PROTOCOL_MINOR, PROTOCOL_VERSION};

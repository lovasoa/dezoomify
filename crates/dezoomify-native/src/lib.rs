//! Native effect runtime: real HTTP egress (rustls), header/auth scope,
//! bounded scheduler bookkeeping, tile resume cache (storage `cache`),
//! output validation, progress
//! counters, image decode/assemble/encode pipeline (PNG, JPEG, TIFF, ZIF
//! pyramid, WebP, and static `iiif-dir` tile trees), and real output hashing.
#![forbid(unsafe_code)]
// 6.1 unwrap policy: shipped runtime code maps failures to typed
// `NativeError`s instead of panicking (see the crate-root comment in
// `dezoomify-protocol` for how tests stay exempt).
#![deny(clippy::unwrap_used)]

pub mod auth;
pub mod cache;
pub mod client;
pub mod error;
pub mod exec;
pub mod http;
pub mod output;
pub mod pipeline;
pub mod progress;
pub mod runner;
pub mod sink;
pub mod transport;

pub use error::NativeError;
pub use runner::{
    CommandRejected, JobCommandAck, JobOptions, JobSnapshot, NativeRunner, OutputSummary,
    OutputTarget, RunningJob, UserCommand,
};

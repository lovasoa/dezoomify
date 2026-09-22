//! Native effect runtime: real HTTP egress (rustls), header/auth scope,
//! bounded scheduler bookkeeping, tile resume cache (storage `cache`),
//! output validation,
//! image decode/assemble/encode pipeline (PNG, JPEG, TIFF, ZIF
//! pyramid, WebP, and static `iiif-dir` tile trees), and real output hashing.
#![forbid(unsafe_code)]
// 6.1 unwrap policy: shipped runtime code maps failures to typed
// `NativeError`s instead of panicking (see `dezoomify::model` for the
// shared contract policy and how tests stay exempt).
#![deny(clippy::unwrap_used)]

pub mod auth;
pub mod cache;
pub mod client;
pub mod error;
pub mod exec;
pub mod http;
pub mod job_service;
pub mod output;
pub mod pipeline;
pub mod sink;
pub mod transport;

pub use error::NativeError;
pub use job_service::{
    start_job, CommandRejected, JobCommandAck, JobOptions, JobSnapshot, OutputSummary,
    OutputTarget, RunningJob, UserCommand,
};

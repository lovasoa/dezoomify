//! Native effect runtime: real HTTP egress (rustls), header/auth scope,
//! bounded scheduler bookkeeping, cache helpers, output validation, progress
//! counters, image decode/assemble/encode pipeline, and real output hashing.

pub mod auth;
pub mod cache;
pub mod client;
pub mod download;
pub mod error;
pub mod http;
pub mod output;
pub mod pipeline;
pub mod progress;
pub mod runtime;

pub use runtime::{JobEvent, JobHandle, JobRequest, JobResult, NativeRuntime};

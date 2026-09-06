//! Native effect runtime: real HTTP egress (rustls), header/auth scope,
//! bounded scheduler bookkeeping, tile resume cache (storage `cache`),
//! output validation, progress
//! counters, image decode/assemble/encode pipeline (PNG, JPEG, TIFF, ZIF
//! pyramid, WebP, and static `iiif-dir` tile trees), and real output hashing.
#![forbid(unsafe_code)]

pub mod auth;
pub mod cache;
pub mod client;
pub mod download;
pub mod error;
pub mod http;
pub mod job_driver;
pub mod output;
pub mod pipeline;
pub mod progress;
pub mod runtime;

pub use error::NativeError;
pub use runtime::{JobEvent, JobEventKind, JobHandle, JobRequest, JobResult, NativeRuntime};

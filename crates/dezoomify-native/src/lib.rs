#![forbid(unsafe_code)]
// 6.1 unwrap policy: shipped runtime code maps failures to typed
// `NativeError`s instead of panicking (see `dezoomify::model` for the
// shared contract policy and how tests stay exempt).
#![deny(clippy::unwrap_used)]

pub mod auth;
pub mod cache;
pub mod client;
pub mod diagnostics;
pub mod error;
pub mod host;
pub mod http;
pub mod options;
pub mod output;
pub mod pipeline;
pub mod sink;
pub mod transport;

pub use error::NativeError;
pub use host::{Controls, Instrumentation, NativeHost, OutputSummary};
pub use options::{JobOptions, OutputTarget};

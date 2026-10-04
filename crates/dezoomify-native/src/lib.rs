#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used)]
// Platform operations return the shared error value with its diagnostic facts.
#![allow(clippy::result_large_err)]

pub mod cache;
pub mod client;
pub mod diagnostics;
pub mod host;
pub mod html;
pub mod http;
pub mod imaging;
pub mod options;
pub mod output;
pub mod sink;
pub mod transport;

pub use host::{Controls, Instrumentation, NativeHost, Publication};
pub use options::{JobOptions, OutputTarget};

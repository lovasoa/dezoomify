#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used)]
// Platform operations return the shared error value with its diagnostic facts.
#![allow(clippy::result_large_err)]

mod blob_store;
mod buffers;
pub mod cache;
pub mod client;
mod codecs;
pub mod diagnostics;
mod encoded_spool;
mod encoded_tile;
mod formats;
pub mod host;
pub mod html;
pub mod http;
pub mod imaging;
pub mod options;
pub mod output;
mod pixel_pipe;
mod pixel_store;
mod raster;
mod storage;
mod tile_geometry;
mod tile_output;
mod tile_pyramid;
pub mod transport;

pub use document::{DocumentPage, DocumentPublication, OutputDocument};
pub use formats::pdf::pages as document;
pub use host::{Controls, Instrumentation, NativeHost, Publication};
pub use options::{JobOptions, OutputTarget};

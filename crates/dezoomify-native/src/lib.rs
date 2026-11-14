#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used)]
// Platform operations return the shared error value with its diagnostic facts.
#![allow(clippy::result_large_err)]

pub mod cache;
pub mod client;
pub mod diagnostics;
pub mod document;
mod encoded_spool;
mod encoded_tile;
pub mod host;
pub mod html;
pub mod http;
mod iiif_output;
pub mod imaging;
pub mod options;
pub mod output;
mod pdf_document;
mod pdf_images;
mod pdf_output;
mod pixel_pipe;
mod pixel_store;
mod raster;
mod tile_budget;
mod tile_geometry;
mod tile_output;
mod tile_pyramid;
pub mod transport;
mod zif_output;

pub use document::{DocumentPage, DocumentPublication, OutputDocument};
pub use host::{Controls, Instrumentation, NativeHost, Publication};
pub use options::{JobOptions, OutputTarget};

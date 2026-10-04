//! Shared image discovery, geometry, and asynchronous dezooming.
//! Platform I/O is supplied through the Host capability contract.
#![forbid(unsafe_code)]
#![cfg_attr(not(test), deny(clippy::disallowed_methods, clippy::disallowed_types))]
#![cfg_attr(test, allow(clippy::disallowed_methods, clippy::disallowed_types))]
#![deny(clippy::cognitive_complexity)]
#![deny(clippy::too_many_lines)]
#![allow(clippy::pedantic)]
// The discovery API is documented for readers, but does not yet annotate every
// `Result`-returning function with `# Errors` and `# Panics` sections.
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]

#[cfg(test)]
extern crate self as dezoomify;

pub mod arcgis;
pub mod bulk_text;
pub mod core;
pub mod custom_yaml;
pub mod dzi;
pub mod fsi;
pub mod fzp;
pub mod generic;
pub mod google_arts_and_culture;
pub mod hungaricana;
pub mod iiif;
pub mod iipimage;
pub mod krpano;
pub mod lizardtech;
pub mod pnav;
pub mod second_canvas;
pub mod topviewer;
pub mod vec2d;
pub mod vls;
pub mod wmts;
pub mod xlimage;
pub mod zoomify;

/// Canonical public values shared by discovery and hosts.
pub mod model;

pub mod host;
pub mod retry;
mod run;
pub use host::Host;
pub use run::dezoomify;

mod javascript;
mod json_utils;
mod markup;
mod template;
#[cfg(test)]
mod test_support;
mod web_page;

pub use vec2d::Vec2d;

/// Browser-like headers sent by default with every request, both by the
/// application's HTTP client and by `custom_yaml` tile requests.
///
/// # Panics
///
/// Panics if the bundled `default_headers.yaml` fails to parse, which would be
/// a bug in this crate.
#[must_use]
pub fn default_headers() -> std::collections::HashMap<String, String> {
    serde_yaml::from_str(include_str!("default_headers.yaml"))
        .expect("bundled default headers must be valid YAML")
}

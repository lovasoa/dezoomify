//! FreezoomPack (`fzp`): verified JPEG layouts, not an official standard.
//!
//! `content/resource` (also named `image`), under `pal` or `self`, supplies geometry.
//! `ver` and `version` must agree. Level 0 is full resolution; scale is 2^L.
//! Version 1.3 rounds up; 1.1, 1.2 and absent versions floor dimensions.
//! Only positive stored levels appear. Origins and overlap are zero, `divbase`
//! is absent or 2, and missing `mime` means JPEG. Other variants are rejected.
//!
//! Pattern `0/00000` (the default) produces `{level}/{x:05}{y:05}{width:05}{height:05}.jpg`.
//! Fields describe clipped original-coordinate rectangles and must fit five
//! digits; decoded extents use the version's rounding. Tile URLs use the final
//! metadata directory. `url="."`, `src`, `nest`, `rect`, and preview geometry
//! do not change that base or image geometry.
//!
//! Literal Lime calls and known wrappers follow bounded metadata traversal;
//! script paths retain the viewer document's base.
//! Named wrappers use their matching definition before the image invocation.
//! Comparison declarations expose both images as deferred entries.
//! Viewer entry documents require a supported literal declaration before
//! auxiliary scripts are fetched; generic script tags are not format evidence.
//! XML indexes produce ordered, deferred catalogs. Direct indexes under `xmls/` infer sibling
//! `resources/`; query parameters do not implicitly select pages.
//!
//! Provenance (observed 2026-09-29):
//! - [Yokohama 1.1](https://www-user.yokohama-cu.ac.jp/~ycu-rare/resources/WC-0_155/root.xml)
//! - [Nara 1.1](https://www.nara-wu.ac.jp/aic/gdb/mahoroba/y14/y14/resources/nihonryoiki_01/root.xml)
//! - [Nihon 1.3](https://www.law.nihon-u.ac.jp/library/htmls-201901/resources/1499_02/02_002/root.xml)
//! - [Unversioned JSCE](https://www.library-jsce.jp/drawing/2011_Tokyo/resources/12562_001/root.xml)
//!
//! Offline fixtures verify native/WASM/browser parity. Base-32/block filenames,
//! alternate suffixes, overlap, and 3.x remain unsupported.

mod metadata;
#[cfg(test)]
mod tests;
mod viewer;

use std::sync::LazyLock;

use regex::bytes::Regex;

use crate::core::discovery::{
    any, content_matches, metadata as route, resource_matches, viewer as viewer_route,
};
use crate::core::{DiscoveryError, DiscoveryResource, DiscoveryRoute, FormatSpec, ParsedResource};

static METADATA_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)<(?:pal|items?)[\s/>]").expect("constant FreezoomPack metadata pattern")
});

const ROUTES: &[DiscoveryRoute] = &[
    route(content_matches(&METADATA_RE)).decode(decode),
    viewer_route(resource_matches(viewer::recognizes)).decode(viewer::decode),
    route(any()).child_metadata(decode),
];
pub const SPEC: FormatSpec = FormatSpec::new("fzp", ROUTES)
    .with_display_name("FreezoomPack")
    .on_failure(viewer::failed_script);

fn invalid(detail: impl std::fmt::Display) -> DiscoveryError {
    let detail = detail.to_string();
    let mut characters = detail.chars();
    let prefix: String = characters.by_ref().take(512).collect();
    let omitted = characters.count();
    let suffix = if omitted == 0 {
        String::new()
    } else {
        format!("… ({omitted} characters omitted)")
    };
    DiscoveryError::InvalidMetadata(format!("FreezoomPack: {prefix}{suffix}"))
}

fn decode(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let text = resource.text_lossy();
    match metadata::root_name(&text).as_deref() {
        Some("pal") => metadata::image(&text, resource.final_uri()),
        Some("item") => metadata::index(&text, resource),
        Some("items") => Err(invalid(
            "unsupported legacy page index layout: items/field/name",
        )),
        _ => viewer::decode(resource),
    }
}

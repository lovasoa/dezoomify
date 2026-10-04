//! Stable registration and precedence policy for pure formats.

use super::discovery::{DiscoveryInput, DiscoveryLimits, FormatSpec};
use crate::{
    arcgis, bulk_text, custom_yaml, dzi, fsi, fzp, generic, google_arts_and_culture, hungaricana,
    iiif, iipimage, krpano, lizardtech, pnav, second_canvas, topviewer, vls, wmts, xlimage,
    zoomify,
};

/// Every built-in format, in candidate priority order.
const BUILTINS: &[FormatSpec] = &[
    custom_yaml::SPEC,
    google_arts_and_culture::SPEC,
    zoomify::SPEC,
    iiif::SPEC,
    dzi::SPEC,
    fzp::SPEC,
    second_canvas::SPEC,
    generic::SPEC,
    krpano::SPEC,
    iipimage::SPEC,
    xlimage::SPEC,
    topviewer::SPEC,
    fsi::SPEC,
    lizardtech::SPEC,
    vls::SPEC,
    hungaricana::SPEC,
    wmts::SPEC,
    arcgis::SPEC,
    pnav::SPEC,
    bulk_text::SPEC,
];

/// Built-in format names in candidate priority order.
pub fn builtin_names() -> impl Iterator<Item = &'static str> {
    BUILTINS.iter().map(FormatSpec::name)
}

/// An ordered set of formats to try. Earlier registrations have priority.
#[derive(Default, Clone)]
pub struct Registry {
    specs: Vec<FormatSpec>,
}

impl Registry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register one format. Earlier registrations are tried first.
    pub fn register(&mut self, spec: FormatSpec) {
        self.specs.push(spec);
    }

    /// Resolve supplied sources with platform resource acquisition.
    pub async fn discover<F, Fut, P, PFut>(
        &self,
        inputs: Vec<DiscoveryInput>,
        limits: DiscoveryLimits,
        fetch: F,
        parse_html: P,
    ) -> Result<super::DiscoveryCatalog, super::DiscoveryError>
    where
        F: Fn(super::Request, crate::model::Interaction) -> Fut,
        Fut: std::future::Future<Output = Result<crate::model::ResourceRead, crate::model::Error>>,
        P: Fn(crate::model::HtmlQuery) -> PFut,
        PFut: std::future::Future<Output = Result<crate::model::HtmlDocument, crate::model::Error>>,
    {
        super::discovery::discover(inputs, &self.specs, limits, fetch, parse_html).await
    }

    /// Look up a registered format by stable id.
    #[must_use]
    pub fn spec_named(&self, name: &str) -> Option<&FormatSpec> {
        self.specs.iter().find(|spec| spec.name() == name)
    }

    /// Ordered `(id, display_name)` entries for review and UI labels.
    #[must_use]
    pub fn formats(&self) -> Vec<(&'static str, &'static str)> {
        self.specs
            .iter()
            .map(|spec| (spec.name(), spec.display_name()))
            .collect()
    }
}

/// Compose every built-in format. Discovery owns per-resource ordering.
#[must_use]
pub fn default_registry() -> Registry {
    Registry {
        specs: BUILTINS.to_vec(),
    }
}

/// Resolve a single built-in format by its name.
#[must_use]
pub fn registry_for(name: &str) -> Option<Registry> {
    let spec = BUILTINS
        .iter()
        .find(|spec| spec.name().eq_ignore_ascii_case(name))
        .copied()?;
    Some(Registry { specs: vec![spec] })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Vec2d;
    use crate::core::discovery::{ParsedResource, css, metadata};
    use crate::core::{DiscoveredEntry, ImagePlan, Request, ResolvedLevel, TileSource};

    #[test]
    fn a_regular_format_needs_only_a_decoder_and_tile_address() {
        fn decode(
            resource: super::super::DiscoveryResource<'_>,
        ) -> Result<ParsedResource, super::super::DiscoveryError> {
            let width = resource.element()?.positive_u32("data-width")?;
            let level = ResolvedLevel::grid(Vec2d { x: width, y: 2 }, Vec2d::square(2), |tile| {
                Request::new(format!(
                    "memory://tile/{}/{}",
                    tile.coord.column, tile.coord.row
                ))
            })?;
            Ok(ParsedResource::Image(ImagePlan::new(
                Some("Toy image".into()),
                vec![level],
            )))
        }

        const TOY: FormatSpec = FormatSpec::new(
            "toy",
            &[metadata(css(".viewer > a[data-width]:first-child")).decode(decode)],
        );
        let mut registry = Registry::new();
        registry.register(TOY);
        let parses = std::cell::Cell::new(0);
        let catalog = futures::executor::block_on(registry.discover(
            vec![DiscoveryInput::with_contents("memory://metadata", br#"<template><div class=viewer><a data-width=99></a></div></template><script>'<div class=viewer><a data-width=88></a></div>'</script><div class=viewer><a data-width=4 title='A > B &amp; C'></a></div>"#)],
            DiscoveryLimits::default(),
            |_, _| async { panic!("supplied HTML must not be fetched") },
            |query| { parses.set(parses.get() + 1); crate::test_support::parse_html(query) },
        ))
        .unwrap();
        assert_eq!(parses.get(), 1);
        let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
            panic!("toy decoder must publish an image")
        };
        assert_eq!(image.format, "toy");
        let TileSource::Grid(grid) = &image.levels[0].source else {
            panic!("toy level must be a grid")
        };
        assert_eq!(grid.count(), 2);
        assert_eq!(
            grid.tiles_row_major().last().unwrap().unwrap().request.uri,
            "memory://tile/1/0"
        );
    }

    #[test]
    fn every_builtin_has_a_display_name() {
        for (id, name) in default_registry().formats() {
            assert!(!name.is_empty(), "{id} has a display name");
        }
    }

    #[test]
    fn every_builtin_name_resolves_to_one_format() {
        for name in builtin_names() {
            let registry = registry_for(name).unwrap_or_else(|| {
                panic!("built-in `{name}` must resolve");
            });
            assert_eq!(registry.specs.len(), 1);
            assert_eq!(registry.specs[0].name(), name);
        }
        assert!(registry_for("nope").is_none());
    }

    #[test]
    fn content_driven_formats_read_unknown_urls() {
        for name in ["iiif", "deepzoom"] {
            let calls = std::cell::Cell::new(0);
            let result = futures::executor::block_on(registry_for(name).unwrap().discover(
                vec![DiscoveryInput::new("memory://unknown")],
                DiscoveryLimits::default(),
                |_, _| {
                    calls.set(calls.get() + 1);
                    async {
                        Ok(crate::model::ResourceRead::Response {
                            response: crate::model::ResourceResponse {
                                bytes: b"bad metadata".to_vec(),
                                final_uri: None,
                            },
                        })
                    }
                },
                crate::test_support::parse_html,
            ));
            assert!(result.is_err());
            assert_eq!(calls.get(), 1, "{name}");
        }
    }
}

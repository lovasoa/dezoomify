//! Stable registration and precedence policy for pure formats.

use super::discovery::{DiscoveryInput, DiscoveryLimits, DiscoveryOperation, FormatSpec};
use crate::{
    arcgis, bulk_text, custom_yaml, dzi, fsi, generic, google_arts_and_culture, hungaricana, iiif,
    iipimage, krpano, lizardtech, pnav, second_canvas, topviewer, vls, wmts, xlimage, zoomify,
};

/// Every built-in format, in candidate priority order.
const BUILTINS: &[FormatSpec] = &[
    custom_yaml::SPEC,
    google_arts_and_culture::SPEC,
    zoomify::SPEC,
    iiif::SPEC,
    dzi::SPEC,
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

    /// Start a discovery operation with candidates in registration order.
    #[must_use]
    pub fn start(&self, uri: impl Into<String>) -> DiscoveryOperation {
        self.start_with_limits(uri, DiscoveryLimits::default())
    }

    /// Start independent parser state with explicit operation limits.
    #[must_use]
    pub fn start_with_limits(
        &self,
        uri: impl Into<String>,
        limits: DiscoveryLimits,
    ) -> DiscoveryOperation {
        self.start_inputs_with_limits(vec![DiscoveryInput::new(uri)], limits)
    }

    /// Start one bounded search across user sources and host observations.
    #[must_use]
    pub fn start_inputs(&self, inputs: Vec<DiscoveryInput>) -> DiscoveryOperation {
        self.start_inputs_with_limits(inputs, DiscoveryLimits::default())
    }

    /// Start a source-and-observation search with explicit shared limits.
    #[must_use]
    pub fn start_inputs_with_limits(
        &self,
        inputs: Vec<DiscoveryInput>,
        limits: DiscoveryLimits,
    ) -> DiscoveryOperation {
        DiscoveryOperation::from_inputs(inputs, &self.specs, limits)
    }

    /// Look up a registered format by stable id.
    #[must_use]
    pub fn spec_named(&self, name: &str) -> Option<&FormatSpec> {
        self.specs.iter().find(|spec| spec.name() == name)
    }

    /// Ordered `(id, display_name)` snapshot for review and UI labels.
    #[must_use]
    pub fn snapshot(&self) -> Vec<(&'static str, &'static str)> {
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
    let mut registry = Registry::new();
    registry.register(spec);
    Some(registry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Vec2d;
    use crate::core::discovery::{DiscoveryStep, ResourceResponse, any, metadata};
    use crate::core::{DiscoveredEntry, ImagePlan, Request, ResolvedLevel, TileSource};

    #[test]
    fn a_regular_format_needs_only_a_decoder_and_tile_address() {
        fn decode(
            resource: super::super::DiscoveryResource<'_>,
        ) -> Result<DiscoveryStep, super::super::DiscoveryError> {
            let bytes = resource.bytes();
            let width = u32::from(*bytes.first().unwrap());
            let level = ResolvedLevel::grid(Vec2d { x: width, y: 2 }, Vec2d::square(2), |tile| {
                Request::new(format!(
                    "memory://tile/{}/{}",
                    tile.coord.column, tile.coord.row
                ))
            })?;
            Ok(DiscoveryStep::Image(ImagePlan::new(
                Some("Toy image".into()),
                vec![level],
            )))
        }

        const TOY: FormatSpec = FormatSpec::new("toy", &[metadata(any()).decode(decode)]);
        let mut registry = Registry::new();
        registry.register(TOY);
        let mut operation = registry.start("memory://metadata");
        let resource = operation.missing_resources().unwrap().remove(0);
        operation
            .provide(ResourceResponse::new(resource.id, [4]))
            .unwrap();
        let catalog = operation.finish().unwrap();
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
    fn registry_snapshot_lists_ids_and_display_names() {
        // Reviewed order: registry order defines automatic precedence.
        let registry = default_registry();
        assert_eq!(
            registry.snapshot(),
            [
                ("custom", "Custom tiles"),
                ("google_arts_and_culture", "Arts & Culture"),
                ("zoomify", "Zoomify"),
                ("iiif", "IIIF"),
                ("deepzoom", "Seadragon (Deep Zoom Image)"),
                ("second_canvas", "Second Canvas"),
                ("generic", "Generic format"),
                ("krpano", "krpano"),
                ("iipimage", "IIPImage"),
                ("xlimage", "XLimage"),
                ("topviewer", "TopViewer"),
                ("fsi", "FSI"),
                ("lizardtech", "LizardTech ImageServer"),
                ("vls", "VLS"),
                ("hungaricana", "Hungaricana"),
                ("wmts", "WMTS"),
                ("arcgis", "ArcGIS MapServer"),
                ("pnav", "pnav"),
                ("bulk_text", "Bulk text"),
            ]
        );
    }

    #[test]
    fn every_builtin_name_resolves_to_a_single_program() {
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
    fn content_driven_formats_request_even_without_a_url_match() {
        for name in ["iiif", "deepzoom"] {
            let mut operation = registry_for(name).unwrap().start("memory://unknown");
            assert_eq!(operation.missing_resources().unwrap().len(), 1, "{name}");
        }
    }
}

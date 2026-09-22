//! Stable registration and precedence policy for pure formats.

use super::discovery::{DiscoveryLimits, DiscoveryOperation, FormatSpec};
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
        DiscoveryOperation::new(uri.into(), &self.specs, limits)
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

/// The first built-in format which prefers `uri`.
fn preferred_name(uri: &str) -> Option<&'static FormatSpec> {
    BUILTINS.iter().find(|spec| spec.prefers(uri))
}

/// Compose every built-in format, preferring the one whose URL hints match.
#[must_use]
pub fn default_registry(uri: &str) -> Registry {
    let preferred = preferred_name(uri);
    let is_other = |&b: &&FormatSpec| !preferred.is_some_and(|d| b == d);
    let others = BUILTINS.iter().filter(is_other);
    let specs = preferred.iter().copied().chain(others).copied().collect();
    Registry { specs }
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

    #[test]
    fn registry_snapshot_lists_ids_and_display_names() {
        // Reviewed order: registry order defines automatic precedence.
        let registry = default_registry("https://example.test/unknown");
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
    fn route_preferences_promote_the_matching_program() {
        assert_eq!(
            preferred_name("x/info.json").map(FormatSpec::name),
            Some("iiif")
        );
        assert_eq!(preferred_name("x/unknown").map(FormatSpec::name), None);
        assert_eq!(
            default_registry("x/info.json").specs[0].name(),
            "iiif",
            "the matching program must be tried first"
        );
        assert_eq!(
            preferred_name("server?fif=image.tif").map(FormatSpec::name),
            Some("iipimage")
        );
        assert_eq!(
            preferred_name("x/TileGroup0/0-0-0.jpg").map(FormatSpec::name),
            Some("zoomify")
        );
    }

    #[test]
    fn default_registry_without_a_hint_keeps_definition_order() {
        assert_eq!(default_registry("x/unknown").specs[0].name(), "custom");
        let _ = default_registry("x/unknown").start("memory://root");
    }

    #[test]
    fn content_driven_formats_request_even_without_a_url_match() {
        for name in ["iiif", "deepzoom"] {
            let mut operation = registry_for(name).unwrap().start("memory://unknown");
            assert_eq!(operation.missing_resources().unwrap().len(), 1, "{name}");
        }
    }
}

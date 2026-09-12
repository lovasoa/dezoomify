//! Stable registration and precedence policy for pure dezoomers.

use super::discovery::{DezoomerSpec, DiscoveryLimits, DiscoveryOperation};
use crate::{
    arcgis, bulk_text, custom_yaml, dzi, fsi, generic, google_arts_and_culture, hungaricana, iiif,
    iipimage, krpano, lizardtech, pnav, second_canvas, topviewer, vls, wmts, xlimage, zoomify,
};

/// Every built-in dezoomer, in candidate priority order.
const BUILTINS: &[DezoomerSpec] = &[
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

/// Built-in dezoomer names in candidate priority order.
pub fn builtin_names() -> impl Iterator<Item = &'static str> {
    BUILTINS.iter().map(DezoomerSpec::name)
}

/// An ordered set of dezoomers to try. Earlier registrations have priority.
#[derive(Default, Clone)]
pub struct Registry {
    specs: Vec<DezoomerSpec>,
}

impl Registry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register one dezoomer. Earlier registrations are tried first.
    pub fn register(&mut self, spec: DezoomerSpec) {
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
    pub fn spec_named(&self, name: &str) -> Option<&DezoomerSpec> {
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

/// The first built-in dezoomer which prefers `uri`.
fn preferred_name(uri: &str) -> Option<&'static DezoomerSpec> {
    BUILTINS.iter().find(|spec| spec.prefers(uri))
}

/// A candidate URL ranked against the builtin formats: the input URL plus the
/// preferred builtin format name, if any builtin prefers it. Ranking is pure
/// (URL text only, no fetching) and total (unknowns rank last, never dropped).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RankedCandidate<'a> {
    pub url: &'a str,
    pub format: Option<&'static str>,
}

/// The preferred builtin format for `url`, if any builtin prefers it.
#[must_use]
pub fn classify_url(url: &str) -> Option<&'static str> {
    preferred_name(url).map(DezoomerSpec::name)
}

fn builtin_index(name: &str) -> usize {
    BUILTINS
        .iter()
        .position(|spec| spec.name() == name)
        .unwrap_or(usize::MAX)
}

/// Rank candidate URLs without fetching: known formats first in builtin order,
/// unknowns last in first-seen order. Stable and total: every input URL is
/// returned exactly once, so callers try in order until discovery succeeds.
#[must_use]
pub fn rank_candidate_urls<'a>(urls: &[&'a str]) -> Vec<RankedCandidate<'a>> {
    let mut ranked: Vec<(usize, RankedCandidate<'a>)> = urls
        .iter()
        .enumerate()
        .map(|(index, url)| {
            (
                index,
                RankedCandidate {
                    url,
                    format: classify_url(url),
                },
            )
        })
        .collect();
    ranked.sort_by_key(|(index, candidate)| match candidate.format {
        Some(name) => (0, builtin_index(name), *index),
        None => (1, usize::MAX, *index),
    });
    ranked.into_iter().map(|(_, candidate)| candidate).collect()
}

/// Compose every built-in dezoomer, preferring the one whose URL hints match.
#[must_use]
pub fn default_registry(uri: &str) -> Registry {
    let preferred = preferred_name(uri);
    let is_other = |&b: &&DezoomerSpec| !preferred.is_some_and(|d| b == d);
    let others = BUILTINS.iter().filter(is_other);
    let specs = preferred.iter().copied().chain(others).copied().collect();
    Registry { specs }
}

/// Resolve a single built-in dezoomer by its name.
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
                ("generic", "Generic dezoomer"),
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
            preferred_name("x/info.json").map(DezoomerSpec::name),
            Some("iiif")
        );
        assert_eq!(preferred_name("x/unknown").map(DezoomerSpec::name), None);
        assert_eq!(
            default_registry("x/info.json").specs[0].name(),
            "iiif",
            "the matching program must be tried first"
        );
        assert_eq!(
            preferred_name("server?fif=image.tif").map(DezoomerSpec::name),
            Some("iipimage")
        );
        assert_eq!(
            preferred_name("x/TileGroup0/0-0-0.jpg").map(DezoomerSpec::name),
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

    #[test]
    fn classify_url_returns_the_preferred_builtin() {
        assert_eq!(classify_url("x/info.json"), Some("iiif"));
        assert_eq!(classify_url("server?fif=image.tif"), Some("iipimage"));
        assert_eq!(classify_url("x/TileGroup0/0-0-0.jpg"), Some("zoomify"));
        assert_eq!(
            classify_url("https://example.test/tiles.yaml?version=2"),
            Some("custom")
        );
        assert_eq!(classify_url("https://example.test/unknown"), None);
    }

    #[test]
    fn rank_candidate_urls_is_total_stable_and_known_first() {
        let urls = [
            "https://example.test/unknown-b",
            "https://example.test/TileGroup0/0-0-0.jpg",
            "https://example.test/unknown-a",
            "https://example.test/info.json",
        ];
        let ranked = rank_candidate_urls(&urls);
        let ordered: Vec<&str> = ranked.iter().map(|candidate| candidate.url).collect();
        // zoomify precedes iiif in builtin order; unknowns keep first-seen order.
        assert_eq!(
            ordered,
            [
                "https://example.test/TileGroup0/0-0-0.jpg",
                "https://example.test/info.json",
                "https://example.test/unknown-b",
                "https://example.test/unknown-a",
            ]
        );
        assert_eq!(ranked[0].format, Some("zoomify"));
        assert_eq!(ranked[1].format, Some("iiif"));
        assert_eq!(ranked[2].format, None);
        assert!(rank_candidate_urls(&[]).is_empty());
    }
}

mod support;

use dezoomify::core::discovery::DiscoveryInput;
use dezoomify::core::{DiscoveredEntry, registry_for};
use dezoomify::model::DiscoveryInputKind;

#[test]
fn declared_manifest_precedes_a_loaded_snapshot_also_seen_in_network_history() {
    const PAGE: &str = "https://iiif.nichibun.ac.jp/YSD/detail/002463024.html";
    const MANIFEST: &str = "https://iiif.nichibun.ac.jp/IIIF/manifest/YSD/002463024.json";
    const INFO: &str =
        "https://iiif.nichibun.ac.jp/iipsrv?IIIF=/YSD/002463024/002463024_o.tif/info.json";
    let (catalog, requests) = support::discover_inputs(
        dezoomify::core::default_registry(),
        vec![
            DiscoveryInput::with_contents(
                PAGE,
                include_str!("../../../apps/extension/tests/browser/corpus/mirador/viewer.html"),
            ),
            DiscoveryInput::new(INFO).with_kind(DiscoveryInputKind::ObservedResource),
            DiscoveryInput::with_contents(
                INFO,
                include_str!("../../../apps/extension/tests/browser/corpus/mirador/info.json"),
            )
            .with_kind(DiscoveryInputKind::ObservedMetadata),
        ],
        Default::default(),
        |uri| {
            assert_eq!(uri, MANIFEST);
            Some(Ok((
                include_bytes!(
                    "../../../apps/extension/tests/browser/corpus/mirador/manifest.json"
                )
                .to_vec(),
                None,
            )))
        },
    );
    let catalog = catalog.unwrap();
    assert_eq!(catalog.entries().len(), 2);
    assert!(
        catalog
            .entries()
            .iter()
            .all(|entry| matches!(entry, DiscoveredEntry::Deferred(_)))
    );
    assert_eq!(requests.len(), 1);
}

#[test]
fn literal_mirador_configuration_resolves_the_selected_manifest_against_the_page_base() {
    for config in [
        r#"{data:[{manifestUri:'other.json'}],windowObjects:[{loadedManifest:'selected.json?token=exact%2Bvalue'}]}"#,
        r#"{data:[{manifestUri:'selected.json?token=exact%2Bvalue'}]}"#,
    ] {
        let page = format!(
            r#"<base href="/catalog/"><script>$(function(){{ Mirador({config}); }});</script>"#
        );
        let (catalog, requests) = support::discover_inputs(
            registry_for("iiif").unwrap(),
            vec![DiscoveryInput::with_contents(
                "https://museum.test/art",
                page,
            )],
            Default::default(),
            |uri| {
                assert_eq!(
                    uri,
                    "https://museum.test/catalog/selected.json?token=exact%2Bvalue"
                );
                Some(Ok((
                    include_bytes!("../../../fixtures/iiif/manifest/manifest.json").to_vec(),
                    None,
                )))
            },
        );
        assert!(matches!(
            catalog.unwrap().entries(),
            [DiscoveredEntry::Deferred(_)]
        ));
        assert_eq!(requests.len(), 1);
    }
}

#[test]
fn comments_strings_inert_scripts_and_expressions_do_not_declare_mirador_manifests() {
    for source in [
        r#"<script>// Mirador({data:[{manifestUri:'/wrong'}]})</script>"#,
        r#"<script>const example = "Mirador({manifestUri:'/wrong'})";</script>"#,
        r#"<template><script>Mirador({data:[{manifestUri:'/wrong'}]})</script></template>"#,
        r#"<script>Mirador({data:[{manifestUri:computed}]})</script>"#,
    ] {
        let (catalog, requests) = support::discover_inputs(
            registry_for("iiif").unwrap(),
            vec![DiscoveryInput::with_contents(
                "https://museum.test/art",
                source,
            )],
            Default::default(),
            |_| panic!("no literal manifest was declared"),
        );
        assert!(catalog.is_err());
        assert!(requests.is_empty());
    }
}

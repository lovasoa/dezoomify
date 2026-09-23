//! Generic URL-template discovery backed by core's executable adaptive plan.

use crate::core::adaptive::is_generic_template;
use crate::core::{
    DiscoverableGrid, DiscoveryError, FormatSpec, ImagePlan, ResolvedLevel, TileSource,
};

pub const SPEC: FormatSpec = FormatSpec::immediate_plan("generic", decode)
    .with_display_name("Generic format")
    .recognizing(is_generic_template, "not a generic X/Y tile template")
    .preferring(|uri| uri.contains("{{"));

fn decode(template: &str) -> Result<ImagePlan, DiscoveryError> {
    Ok(ImagePlan::new(
        Some(template.to_owned()),
        vec![ResolvedLevel::new(TileSource::custom(
            DiscoverableGrid::new(template.to_owned()),
        ))],
    ))
}

#[test]
fn valid_template_completes_on_start_without_resources() {
    let mut registry = crate::core::Registry::new();
    registry.register(SPEC);
    let mut operation = registry.start("tiles/{{X}}/{{Y}}.jpg");
    assert!(operation.missing_resources().unwrap().is_empty());
    assert!(operation.is_complete());
    assert_eq!(operation.finish().unwrap().len(), 1);
}

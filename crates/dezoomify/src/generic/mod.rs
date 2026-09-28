//! Generic URL-template discovery backed by core's executable adaptive plan.

use crate::core::adaptive::is_generic_template;
use crate::core::discovery::image_url;
use crate::core::{DiscoverableGrid, DiscoveryError, FormatSpec, ImagePlan, ResolvedLevel};

pub const SPEC: FormatSpec =
    FormatSpec::new("generic", &[image_url(is_generic_template).plan(decode)])
        .with_display_name("Generic format");

fn decode(template: &str) -> Result<ImagePlan, DiscoveryError> {
    Ok(ImagePlan::new(
        Some(template.to_owned()),
        vec![ResolvedLevel::new(DiscoverableGrid::new(
            template.to_owned(),
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

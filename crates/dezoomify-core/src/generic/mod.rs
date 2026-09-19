//! Generic URL-template discovery backed by core's executable adaptive plan.

use crate::core::adaptive::is_generic_template;
use crate::core::{
    CatalogEntry, DiscoverableGrid, FormatSpec, ImageCatalog, ImageDescriptor, LevelDescriptor,
};

pub const SPEC: FormatSpec = FormatSpec::immediate("generic", |template| Ok(catalog(template)))
    .with_display_name("Generic format")
    .recognizing(is_generic_template, "not a generic X/Y tile template")
    .preferring(|uri| uri.contains("{{"));

fn catalog(template: &str) -> ImageCatalog {
    ImageCatalog::new([CatalogEntry::Ready(ImageDescriptor {
        title: Some(template.to_owned()),
        format: "generic",
        levels: vec![LevelDescriptor::new(DiscoverableGrid::new(
            template.to_owned(),
        ))],
        ..Default::default()
    })])
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

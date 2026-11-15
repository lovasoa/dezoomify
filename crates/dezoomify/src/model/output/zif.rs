use crate::model::{OutputCodec, OutputControl, OutputFormat, OutputLayout};

pub(in crate::model) const CODEC: OutputCodec = OutputCodec {
    format: OutputFormat::Zif,
    name: "ZIF",
    extensions: &["zif"],
    max_side: None,
    control: OutputControl::Effort,
    layout: OutputLayout::Pyramid,
    hint: "zoomable",
    size_coefficients: &[(100, 3.0)],
};

use crate::{
    Vec2d,
    core::{self, TileSource},
};

pub(crate) fn reusable_levels(
    source: &TileSource,
    image: &core::ResolvedImage,
) -> Vec<core::tile_plan::Grid> {
    // ZIF can reuse the source pyramid without asking a pixel encoder to
    // reproduce its codec or JPEG sampling. Keep requests lazy and preserve
    // the selected level as the full-size output.
    let mut lower = Vec::new();
    if let TileSource::Grid(base) = source
        && base.overlap() == Vec2d::default()
        && base.tile_size().x == base.tile_size().y
        && base.tile_size().x.is_multiple_of(16)
    {
        let mut dimensions = base.image_size();
        while dimensions.x > base.tile_size().x || dimensions.y > base.tile_size().y {
            dimensions = Vec2d {
                x: dimensions.x.div_ceil(2),
                y: dimensions.y.div_ceil(2),
            };
            if let Some(grid) = image.levels.iter().find_map(|level| match &level.source {
                TileSource::Grid(grid)
                    if grid.image_size() == dimensions
                        && grid.tile_size() == base.tile_size()
                        && grid.overlap() == Vec2d::default() =>
                {
                    Some(grid.clone())
                }
                _ => None,
            }) {
                lower.push(grid);
            }
        }
    }
    lower
}
